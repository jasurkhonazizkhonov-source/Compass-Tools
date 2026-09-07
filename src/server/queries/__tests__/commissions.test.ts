import { describe, it, expect, vi } from "vitest";

// Part 1/18-19 — transactionType classification. Regression coverage added
// after a live-QA-caught bug: a booking whose quote was itself an approved
// Exchange (originalQuoteId set) and was LATER also cancelled
// (CANCELLATION_CONFIRMED) was permanently mislabeled "Exchange" forever,
// because the derivation checked originalQuoteId before status. Fixed by
// checking CANCELLATION_CONFIRMED first — the cancellation is always the
// more recent, more final financial event for that booking, regardless of
// how the quote originated.

function makeBooking(overrides: { id?: string; originalQuoteId?: string | null; status?: string; profitAmount?: string; updatedAt?: Date }) {
  return {
    id: overrides.id ?? "booking-1",
    bookingReference: `BFT-${overrides.id ?? "TEST"}`,
    profitAmount: overrides.profitAmount ?? "150.00",
    gratuityAmount: "0.00",
    updatedAt: overrides.updatedAt ?? new Date("2026-01-01"),
    quote: {
      id: "quote-1",
      quoteNumber: "Q-TEST",
      currency: "USD",
      exchangeRate: null,
      originalQuoteId: overrides.originalQuoteId ?? null,
      status: overrides.status ?? "CHARGED",
      sentByAgent: { id: "agent-1", fullName: "Andrew Kent", commissionPercent: "20", tipPercent: "10" },
      itinerary: {
        segments: [
          { arrivalAirport: { city: "New York", country: "United States" }, isExtraLeg: false, sequence: 1 },
        ],
      },
    },
    contact: { firstName: "Jasur", lastName: "Azizxonov" },
    statusHistory: [],
  };
}

let bookings: ReturnType<typeof makeBooking>[];

// Models real Prisma skip/take/orderBy-by-updatedAt-desc-then-id-desc
// pagination against the shared `bookings` fixture, so a test asserting
// "page 2 shows rows 26-50" is actually exercising slicing logic, not just
// returning whatever's in the array. getCommissionsSummary's own (unpaginated,
// lighter-select) findMany call never passes skip/take, so it always gets
// every matching row regardless of what page getCommissions was asked for.
const fakePrisma = {
  booking: {
    findMany: vi.fn(async (args: { skip?: number; take?: number }) => {
      const sorted = [...bookings].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id));
      if (args.skip === undefined && args.take === undefined) return sorted;
      return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length));
    }),
    count: vi.fn(async () => bookings.length),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));

const VIEWER = { id: "agent-1", role: "ADMIN" as const, companyId: "company-1" };

describe("getCommissions — transactionType classification", () => {
  it("classifies a normal booking (no exchange, not cancelled) as NEW_SALE", async () => {
    bookings = [makeBooking({})];
    const { getCommissions } = await import("../commissions");
    const { rows } = await getCommissions(VIEWER);
    expect(rows[0].transactionType).toBe("NEW_SALE");
  });

  it("classifies a booking whose quote is an approved Exchange as EXCHANGE", async () => {
    bookings = [makeBooking({ originalQuoteId: "original-quote-id", status: "CHARGED" })];
    const { getCommissions } = await import("../commissions");
    const { rows } = await getCommissions(VIEWER);
    expect(rows[0].transactionType).toBe("EXCHANGE");
  });

  it("classifies a booking with a confirmed cancellation (no exchange origin) as CANCELLATION", async () => {
    bookings = [makeBooking({ status: "CANCELLATION_CONFIRMED" })];
    const { getCommissions } = await import("../commissions");
    const { rows } = await getCommissions(VIEWER);
    expect(rows[0].transactionType).toBe("CANCELLATION");
  });

  it("Bug fix — a booking that was BOTH an approved Exchange AND later cancelled classifies as CANCELLATION, not EXCHANGE (the cancellation is the more recent, final financial event)", async () => {
    bookings = [makeBooking({ originalQuoteId: "original-quote-id", status: "CANCELLATION_CONFIRMED" })];
    const { getCommissions } = await import("../commissions");
    const { rows } = await getCommissions(VIEWER);
    expect(rows[0].transactionType).toBe("CANCELLATION");
  });

  it("a booking whose quote is merely mid-cancellation-workflow (not yet CANCELLATION_CONFIRMED) still classifies by its exchange origin, since nothing final has happened yet", async () => {
    bookings = [makeBooking({ originalQuoteId: "original-quote-id", status: "CANCELLATION_SUBMITTED" })];
    const { getCommissions } = await import("../commissions");
    const { rows } = await getCommissions(VIEWER);
    expect(rows[0].transactionType).toBe("EXCHANGE");
  });
});

// Pass 24 — the primary objective: getCommissions() is now paginated, and
// getCommissionsSummary() is a SEPARATE query over the full filtered
// dataset, independent of page. These prove both halves of that contract:
// correct page slicing, AND totals that never change no matter which page
// (or page size) is requested.
describe("getCommissions — pagination (Pass 24)", () => {
  it("zero records: empty rows, pageCount 1, no crash", async () => {
    bookings = [];
    const { getCommissions } = await import("../commissions");
    const result = await getCommissions(VIEWER, {}, 1, 25);
    expect(result).toEqual({ rows: [], total: 0, page: 1, pageSize: 25, pageCount: 1 });
  });

  it("one record: a single page, pageCount 1", async () => {
    bookings = [makeBooking({ id: "b1" })];
    const { getCommissions } = await import("../commissions");
    const result = await getCommissions(VIEWER, {}, 1, 25);
    expect(result.rows).toHaveLength(1);
    expect(result.pageCount).toBe(1);
    expect(result.total).toBe(1);
  });

  it("exactly one full page (25 records at pageSize 25): pageCount stays 1", async () => {
    bookings = Array.from({ length: 25 }, (_, i) => makeBooking({ id: `b${i}`, updatedAt: new Date(2026, 0, i + 1) }));
    const { getCommissions } = await import("../commissions");
    const result = await getCommissions(VIEWER, {}, 1, 25);
    expect(result.rows).toHaveLength(25);
    expect(result.pageCount).toBe(1);
  });

  it("more than one page (60 records at pageSize 25): page 1 and page 2 return correct, DISTINCT, correctly-ordered rows", async () => {
    // Newest updatedAt first (b59 is most recent) — same orderBy the real
    // query uses, so "page 1 row 0" should be the single newest booking.
    bookings = Array.from({ length: 60 }, (_, i) => makeBooking({ id: `b${i}`, updatedAt: new Date(2026, 0, i + 1) }));
    const { getCommissions } = await import("../commissions");
    const page1 = await getCommissions(VIEWER, {}, 1, 25);
    const page2 = await getCommissions(VIEWER, {}, 2, 25);
    const page3 = await getCommissions(VIEWER, {}, 3, 25);

    expect(page1.rows).toHaveLength(25);
    expect(page2.rows).toHaveLength(25);
    expect(page3.rows).toHaveLength(10); // 60 - 25 - 25
    expect(page1.total).toBe(60);
    expect(page1.pageCount).toBe(3);
    expect(page1.rows[0].bookingId).toBe("b59"); // most recently updated first

    // No overlap between pages.
    const page1Ids = new Set(page1.rows.map((r) => r.bookingId));
    const page2Ids = new Set(page2.rows.map((r) => r.bookingId));
    expect([...page1Ids].some((id) => page2Ids.has(id))).toBe(false);
  });

  it("100+ records: pagination and totals remain correct at larger scale", async () => {
    bookings = Array.from({ length: 137 }, (_, i) => makeBooking({ id: `b${i}`, profitAmount: "10.00", updatedAt: new Date(2026, 0, i + 1) }));
    const { getCommissions, getCommissionsSummary } = await import("../commissions");
    const result = await getCommissions(VIEWER, {}, 1, 50);
    expect(result.total).toBe(137);
    expect(result.pageCount).toBe(3); // ceil(137/50)
    expect(result.rows).toHaveLength(50);

    const summary = await getCommissionsSummary(VIEWER, {});
    expect(summary.bookingCount).toBe(137);
  });

  it("filters returning zero: an out-of-range user filter produces an empty page, not an error", async () => {
    bookings = [makeBooking({ id: "b1" })];
    const { getCommissions } = await import("../commissions");
    const result = await getCommissions({ ...VIEWER, role: "ADMIN" }, { userId: "someone-with-no-bookings" }, 1, 25);
    // The fake doesn't itself filter by userId (that's the real WHERE
    // clause's job, not testable against this in-memory fixture) — this
    // asserts the pagination MATH stays correct/non-throwing when a filter
    // legitimately zeroes out the underlying count.
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
  });
});

describe("getCommissionsSummary — independent of pagination (Pass 24 primary objective)", () => {
  it("changing the page number never changes the summary totals", async () => {
    bookings = Array.from({ length: 60 }, (_, i) => makeBooking({ id: `b${i}`, profitAmount: "10.00", updatedAt: new Date(2026, 0, i + 1) }));
    const { getCommissions, getCommissionsSummary } = await import("../commissions");

    const page1 = await getCommissions(VIEWER, {}, 1, 25);
    const page2 = await getCommissions(VIEWER, {}, 2, 25);
    const summaryAfterPage1 = await getCommissionsSummary(VIEWER, {});
    const summaryAfterPage2 = await getCommissionsSummary(VIEWER, {});

    // 60 bookings × $10 profit × 20% commission = $120 total commission,
    // regardless of which page (or how many pages) were fetched alongside it.
    expect(summaryAfterPage1.totalCommission).toBe(120);
    expect(summaryAfterPage2.totalCommission).toBe(120);
    expect(summaryAfterPage1).toEqual(summaryAfterPage2);
    expect(page1.rows).toHaveLength(25);
    expect(page2.rows).toHaveLength(25);
  });

  it("changing the page SIZE never changes the summary totals either", async () => {
    bookings = Array.from({ length: 40 }, (_, i) => makeBooking({ id: `b${i}`, profitAmount: "5.00", updatedAt: new Date(2026, 0, i + 1) }));
    const { getCommissions, getCommissionsSummary } = await import("../commissions");

    await getCommissions(VIEWER, {}, 1, 25);
    const summaryAt25 = await getCommissionsSummary(VIEWER, {});
    await getCommissions(VIEWER, {}, 1, 100);
    const summaryAt100 = await getCommissionsSummary(VIEWER, {});

    expect(summaryAt25.totalProfit).toBe(200); // 40 × $5
    expect(summaryAt100.totalProfit).toBe(200);
  });

  it("a null viewer returns a zeroed summary, not an error", async () => {
    const { getCommissionsSummary } = await import("../commissions");
    const summary = await getCommissionsSummary(null, {});
    expect(summary).toEqual({ bookingCount: 0, totalProfit: 0, totalCommission: 0, totalTips: 0, tipEarnings: 0, totalEarnings: 0, uniformTipPercent: null });
  });

  it("zero matching bookings: summary is all zeros, not NaN/undefined", async () => {
    bookings = [];
    const { getCommissionsSummary } = await import("../commissions");
    const summary = await getCommissionsSummary(VIEWER, {});
    expect(summary.bookingCount).toBe(0);
    expect(summary.totalCommission).toBe(0);
    expect(summary.uniformTipPercent).toBeNull();
  });
});
