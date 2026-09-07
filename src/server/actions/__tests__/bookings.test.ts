import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake Prisma, same convention as payment-methods.test.ts.
// bookingVisibilityWhere() itself is the REAL implementation (not mocked)
// — only prisma.booking.findFirst is faked, interpreting the exact where
// shape that function produces, so the IDOR/BOLA tests below exercise the
// real authorization logic rather than a re-implementation of it. Focused
// on updateBookingTicketing()'s new auth/IDOR guard (previously this
// function looked up ANY booking by raw id with no check at all) — the
// status-change/confirmation-email branch is deliberately not exercised
// here (kept out of scope for this fixture; see booking-notification.test.ts
// for the notification-sending logic itself).

type FakeAccount = { id: string; role: string; status: string; companyId: string };
type FakeBooking = {
  id: string;
  status: string;
  quoteAgentId?: string;
  leadAssignedAgentId?: string;
  contactOwnerId?: string;
  airlineConfirmations?: unknown;
  airlineConfirmationNumber?: string | null;
  ticketNumbers?: unknown;
  // Pass 32 — for the row-locked profit-recomputation regression tests.
  fareAmount?: number | null;
  taxAmount?: number | null;
  serviceFeeAmount?: number | null;
  profitAmount?: number | null;
};

let currentActor: FakeAccount | null;
let bookings: Map<string, FakeBooking>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/activity-log", () => ({
  logActivity: vi.fn(async () => {}),
}));

vi.mock("@/server/quote-status", () => ({
  reconcileQuoteStatus: vi.fn(async () => ({ fireSideEffects: async () => {} })),
}));

vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({})),
  getCompanyForContactId: vi.fn(async () => ({})),
}));

vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async () => ({ ok: true as const, messageId: "msg-1" })),
}));

vi.mock("@/server/email/templates", () => ({
  buildBookingConfirmationEmail: vi.fn(() => ({ subject: "subject", html: "<p>html</p>" })),
}));

vi.mock("@/server/email/segment-mapper", () => ({
  toEmailSegments: vi.fn(() => []),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakePrisma: any = {
    booking: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = bookings.get(where.id as string);
        if (!row) return null;
        const or = where.OR as Array<Record<string, Record<string, string>>> | undefined;
        if (or) {
          const matches = or.some((cond) => {
            if (cond.quote?.agentId) return row.quoteAgentId === cond.quote.agentId;
            if (cond.lead?.assignedAgentId) return row.leadAssignedAgentId === cond.lead.assignedAgentId;
            if (cond.contact?.ownerId) return row.contactOwnerId === cond.contact.ownerId;
            return false;
          });
          if (!matches) return null;
        }
        return { id: row.id };
      }),
      findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const row = bookings.get(id);
        if (!row) throw new Error(`booking ${id} not found`);
        return {
          id: row.id,
          status: row.status,
          leadId: `lead-for-${id}`,
          contactId: `contact-for-${id}`,
          contactEmail: "customer@example.com",
          ticketNumbers: row.ticketNumbers ?? null,
          pnr: null,
          airlineConfirmationNumber: row.airlineConfirmationNumber ?? null,
          airlineConfirmations: row.airlineConfirmations ?? null,
          contact: { firstName: "Jane", lastName: "Traveler" },
          passengers: [],
          paymentMethods: [],
          quote: { agent: null, sentByAgent: null, currency: "USD", adults: 0, adultPrice: 0, children: 0, childPrice: 0, infants: 0, infantPrice: 0, taxes: 0, serviceFee: 0, exchangeRate: null, itinerary: null },
        };
      }),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeBooking> }) => {
        const row = bookings.get(id)!;
        // Mirror real Prisma semantics: a key present with value `undefined`
        // means "don't touch this field", not "set it to undefined" — the
        // opposite of what plain Object.assign would do.
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) (row as Record<string, unknown>)[key] = value;
        }
        return row;
      }),
    },
    bookingStatusHistory: { create: vi.fn(async () => ({})) },
    emailLog: { create: vi.fn(async () => ({})) },
    paymentCharge: { findMany: vi.fn(async () => []) },
};
// Pass 32 — updateBookingTicketing now takes a real row lock
// (`SELECT ... FOR UPDATE`) inside its transaction immediately before
// computing profitAmount, closing a narrow concurrent-save race (see that
// function's own comment). Mirrors the real query's shape closely enough
// to exercise the merge logic: reads straight from the same in-memory
// `bookings` map the rest of this fake uses, so a test that seeds
// fareAmount/taxAmount/serviceFeeAmount sees them reflected here exactly
// as `tx.booking.update` above would have already committed them.
fakePrisma.$queryRaw = vi.fn(async (_strings: TemplateStringsArray, bookingId: string) => {
  const row = bookings.get(bookingId);
  if (!row) return [];
  return [{ fareAmount: row.fareAmount ?? null, taxAmount: row.taxAmount ?? null, serviceFeeAmount: row.serviceFeeAmount ?? null }];
});
// Interactive-transaction form: runs the callback against this same fake
// client, mirroring updateBookingTicketing's real `prisma.$transaction(async
// (tx) => {...})` usage closely enough to exercise it without a real DB.
fakePrisma.$transaction = vi.fn(async (fn: (tx: typeof fakePrisma) => unknown) => fn(fakePrisma));

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));

beforeEach(() => {
  bookings = new Map();
  currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
  vi.clearAllMocks();
});

function seedBooking(overrides: Partial<FakeBooking> = {}) {
  bookings.set("booking-1", { id: "booking-1", status: "PENDING_TICKETING", ...overrides });
}

describe("updateBookingTicketing — auth + IDOR/BOLA protection", () => {
  it("rejects an unauthenticated (missing) actor", async () => {
    seedBooking();
    currentActor = null;
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "booking-1", pnr: "ABC123" })).rejects.toThrow(/not authorized/i);
  });

  it("rejects an INACTIVE account even with an eligible role", async () => {
    seedBooking();
    currentActor = { id: "admin-1", role: "ADMIN", status: "INACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "booking-1", pnr: "ABC123" })).rejects.toThrow(/not authorized/i);
  });

  it("rejects a booking id that does not exist at all — previously this had NO ownership/visibility check whatsoever", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "does-not-exist", pnr: "ABC123" })).rejects.toThrow(/not authorized/i);
  });

  it("denies a restricted-visibility role (not the owner) from updating a booking outside their scope", async () => {
    seedBooking({ quoteAgentId: "someone-else", leadAssignedAgentId: "someone-else", contactOwnerId: "someone-else" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "booking-1", pnr: "ABC123" })).rejects.toThrow(/not authorized/i);
  });

  it("Part 5/15 — a Travel Agent is denied even when they ARE the owning agent: only Admin/Ticketing Agent may enter ticketing info", async () => {
    seedBooking({ quoteAgentId: "agent-1" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "booking-1", pnr: "ABC123" })).rejects.toThrow(/not authorized/i);
  });

  it("allows an Admin (company-wide visibility) to update any booking within their own scope", async () => {
    seedBooking({ quoteAgentId: "someone-else" });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    const result = await updateBookingTicketing({ bookingId: "booking-1", pnr: "XYZ789" });
    expect(result.id).toBe("booking-1");
  });

  it("allows a Ticketing Agent (company-wide booking visibility, and the correct role for this action) to update any booking", async () => {
    seedBooking({ quoteAgentId: "someone-else" });
    currentActor = { id: "ticketing-1", role: "TICKETING_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    const result = await updateBookingTicketing({ bookingId: "booking-1", pnr: "XYZ789" });
    expect(result.id).toBe("booking-1");
  });

  it("rejects saving a booking as CONFIRMED without Airline Confirmation/Ticket Cost, even for an authorized role", async () => {
    seedBooking();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "booking-1", status: "CONFIRMED" })).rejects.toThrow(/Ticket Cost|Airline Confirmation/i);
  });

  it("PNR Information is internal-only and NOT required to confirm a booking — only Airline Confirmation + Ticket Cost are", async () => {
    // Seeded already-CONFIRMED and re-saved with no `status` in the patch,
    // so the CONFIRMED-gate still applies (finalStatus falls back to
    // existing.status) without entering the status-transition/email branch
    // that this fixture deliberately doesn't exercise (see file header).
    seedBooking({ status: "CONFIRMED" });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    const result = await updateBookingTicketing({
      bookingId: "booking-1",
      airlineConfirmationNumber: "ABC123",
      fareAmount: 500,
    });
    expect(result.id).toBe("booking-1");
  });
});

describe("updateBookingTicketing — Pass 23 multiple airline confirmations", () => {
  it("saves the new multi-entry array and mirrors it into the legacy fields for backward compatibility", async () => {
    seedBooking();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await updateBookingTicketing({
      bookingId: "booking-1",
      airlineConfirmations: [
        { id: "1", airlineIata: "AA", confirmationNumber: "AA123", eTicketNumbers: ["0011"] },
        { id: "2", airlineIata: null, confirmationNumber: "BB456", eTicketNumbers: [] },
      ],
    });
    const saved = bookings.get("booking-1")!;
    expect(saved.airlineConfirmations).toHaveLength(2);
    // Legacy mirror — first entry's number, every entry's e-tickets flattened.
    expect(saved.airlineConfirmationNumber).toBe("AA123");
    expect(saved.ticketNumbers).toEqual(["0011"]);
  });

  it("a legacy-only client (old airlineConfirmationNumber field, no new array) can still confirm a booking — the CONFIRMED gate must see it", async () => {
    // Regression test: the CONFIRMED-check's fallback must merge the
    // PATCH's own legacy field, not just re-read the pre-patch `existing`
    // row (which would incorrectly still show no confirmation and reject
    // a save that DID include one via the old single-value field).
    seedBooking();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    const result = await updateBookingTicketing({
      bookingId: "booking-1",
      airlineConfirmationNumber: "AA123",
      fareAmount: 500,
      status: "CONFIRMED",
    });
    expect(result.id).toBe("booking-1");
  });

  it("rejects confirming a booking whose confirmations array was explicitly saved as empty", async () => {
    seedBooking({ airlineConfirmations: [] });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "booking-1", status: "CONFIRMED", fareAmount: 500 })).rejects.toThrow(/Airline Confirmation/i);
  });

  it("a save that never sends airlineConfirmations (e.g. only editing notes) leaves previously-saved new-format data untouched", async () => {
    seedBooking({ airlineConfirmations: [{ id: "1", airlineIata: "AA", confirmationNumber: "AA123", eTicketNumbers: [] }], airlineConfirmationNumber: "AA123" });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await updateBookingTicketing({ bookingId: "booking-1", bookingNotes: "internal note" });
    const saved = bookings.get("booking-1")!;
    // Prisma `data.field = undefined` is a no-op — untouched, not nulled.
    expect(saved.airlineConfirmations).toEqual([{ id: "1", airlineIata: "AA", confirmationNumber: "AA123", eTicketNumbers: [] }]);
    expect(saved.airlineConfirmationNumber).toBe("AA123");
  });

  it("explicitly removing every row (empty array) is honored, clearing both the new field and the legacy mirror", async () => {
    seedBooking({ airlineConfirmations: [{ id: "1", airlineIata: "AA", confirmationNumber: "AA123", eTicketNumbers: [] }], airlineConfirmationNumber: "AA123" });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await updateBookingTicketing({ bookingId: "booking-1", airlineConfirmations: [] });
    const saved = bookings.get("booking-1")!;
    expect(saved.airlineConfirmations).toEqual([]);
    expect(saved.airlineConfirmationNumber).toBeNull();
    expect(saved.ticketNumbers).toEqual([]);
  });
});

// Pass 32 — real (if narrow) financial-correctness race found and fixed:
// profitAmount previously merged the incoming patch against `existing`, a
// snapshot read at the very TOP of the function (before Zod parsing, the
// visibility check, and this same findUniqueOrThrow all already
// happened) — well before the actual write transaction. If a second
// concurrent save of the SAME booking's ticketing form (a different
// field) committed in that window, the later-committing save's stored
// profitAmount could be computed from a stale merge. Fixed with a real
// row lock (`SELECT ... FOR UPDATE`) taken immediately before computing
// profit, inside the same transaction as the write.
describe("updateBookingTicketing — profitAmount uses a fresh, row-locked read (Pass 32)", () => {
  it("merges a patch that only touches taxAmount against the CURRENT fareAmount, not an unset/stale one", async () => {
    seedBooking({ fareAmount: 500, taxAmount: 0 });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await updateBookingTicketing({ bookingId: "booking-1", taxAmount: 50 });

    const saved = bookings.get("booking-1")!;
    // totalSellingPrice is 0 in this fixture (quote.adults: 0) — profit =
    // 0 - fareAmount(500, merged from the CURRENT row) - taxes(50, this
    // patch) - fee(0) = -550. If the merge had instead used a stale/unset
    // fareAmount, this would come out wrong (e.g. -50).
    expect(Number(saved.profitAmount)).toBe(-550);
  });

  it("computes profitAmount from the row-LOCKED read, not the earlier pre-transaction snapshot — proving the race fix actually takes effect", async () => {
    // Simulate "another transaction already committed a new fareAmount
    // between the outer findUniqueOrThrow and this transaction's own
    // lock": findUniqueOrThrow (the early, pre-transaction read) returns a
    // stale fareAmount, while the live `bookings` map — which $queryRaw
    // (the in-transaction, row-locked read) actually reads from — already
    // has the newer value.
    seedBooking({ fareAmount: 999, taxAmount: 0 }); // the "true", already-committed current value
    fakePrisma.booking.findUniqueOrThrow = vi.fn(async () => ({
      id: "booking-1",
      status: "PENDING_TICKETING",
      leadId: "lead-for-booking-1",
      contactId: "contact-for-booking-1",
      contactEmail: "customer@example.com",
      ticketNumbers: null,
      pnr: null,
      airlineConfirmationNumber: null,
      airlineConfirmations: null,
      fareAmount: 100, // deliberately STALE — must never be what profit is computed from
      contact: { firstName: "Jane", lastName: "Traveler" },
      passengers: [],
      paymentMethods: [],
      quote: { agent: null, sentByAgent: null, currency: "USD", adults: 0, adultPrice: 0, children: 0, childPrice: 0, infants: 0, infantPrice: 0, taxes: 0, serviceFee: 0, exchangeRate: null, itinerary: null },
    }));

    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await updateBookingTicketing({ bookingId: "booking-1", taxAmount: 50 });

    const saved = bookings.get("booking-1")!;
    // If profitAmount had been computed from the stale findUniqueOrThrow
    // snapshot (fareAmount: 100), this would be -150. Using the true,
    // row-locked current value (999) instead gives -1049.
    expect(Number(saved.profitAmount)).toBe(-1049);
    expect(fakePrisma.$queryRaw).toHaveBeenCalled();
  });
});

// Pass 34 — real gap found and fixed: fareAmount/taxAmount/serviceFeeAmount
// had no `.min(0)`, unlike exchangeSchema's/requestCancellationSchema's
// equivalent money fields — a negative Ticket Cost/Tax/Issuing Fee could be
// submitted and would silently inflate the computed profitAmount (a
// negative cost reads as extra profit).
describe("updateBookingTicketing — rejects negative money fields (Pass 34)", () => {
  it("rejects a negative fareAmount (Ticket Cost)", async () => {
    seedBooking({ fareAmount: 500, taxAmount: 0 });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "booking-1", fareAmount: -100 })).rejects.toThrow();
    expect(Number(bookings.get("booking-1")!.fareAmount)).toBe(500); // unchanged
  });

  it("rejects a negative taxAmount", async () => {
    seedBooking({ fareAmount: 500, taxAmount: 0 });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "booking-1", taxAmount: -1 })).rejects.toThrow();
  });

  it("rejects a negative serviceFeeAmount (Issuing Fee)", async () => {
    seedBooking({ fareAmount: 500, taxAmount: 0 });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "booking-1", serviceFeeAmount: -1 })).rejects.toThrow();
  });

  it("still accepts zero for all three (zero is a valid, non-negative cost)", async () => {
    seedBooking({ fareAmount: 500, taxAmount: 0 });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1" };
    const { updateBookingTicketing } = await import("../bookings");
    await expect(updateBookingTicketing({ bookingId: "booking-1", fareAmount: 0, taxAmount: 0, serviceFeeAmount: 0 })).resolves.toBeDefined();
  });
});
