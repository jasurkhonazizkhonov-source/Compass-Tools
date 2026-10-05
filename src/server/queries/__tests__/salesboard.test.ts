import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 24 — getSalesboard moved from "fetch every matching Booking row and
// sum in JS" to a real SQL SUM/COUNT ... GROUP BY, so the leaderboard never
// requires loading an unbounded, ever-growing booking history into
// application memory. This fake models the real aggregation behavior
// (not just "was $queryRaw called") by actually grouping/summing an
// in-memory fixture the same way the real SQL would, keyed off the exact
// interpolated parameters production passes — company scoping and the
// optional period cutoff — so a real company-isolation or period-filter
// regression would be caught here, same convention as lead-queue.test.ts's
// own $queryRaw fake.

type FakeBooking = {
  id: string;
  status: string;
  profitAmount: number | null;
  updatedAt: Date;
  /** When the booking was last moved to CONFIRMED (BookingStatusHistory). Absent = a legacy booking with no history row. */
  confirmedAt?: Date;
  companyId: string;
  sentByAgentId: string | null;
};
type FakeAgent = { id: string; fullName: string; role: string; accountsVisible?: boolean; status?: string };

let bookings: FakeBooking[];
let agents: Map<string, FakeAgent>;

const fakePrisma = {
  // getSalesboard passes one Prisma.Sql: its text and its bind values (company first, then the date bounds that are present).
  $queryRaw: vi.fn(async (query: { sql: string; values: unknown[] }) => {
    // The fake honours the visibility predicate only if the real SQL carries it,
    // so removing it from the query makes the hidden-account tests below fail.
    const filtersHidden = query.sql.includes('a."accountsVisible" = true');
    const companyId = query.values[0] as string;
    const dates = query.values.filter((v): v is Date => v instanceof Date);
    const hasStart = />= (\$\d+|\?)/.test(query.sql);
    const hasEnd = /< (\$\d+|\?)/.test(query.sql);
    const start = hasStart ? dates[0] : undefined;
    const endExclusive = hasEnd ? dates[hasStart ? 1 : 0] : undefined;
    // The sale date is the confirmation event, falling back to updatedAt only for a booking with no history row.
    const saleAt = (b: FakeBooking) => b.confirmedAt ?? b.updatedAt;
    const eligible = bookings.filter(
      (b) =>
        b.status === "CONFIRMED" &&
        b.profitAmount !== null &&
        b.companyId === companyId &&
        b.sentByAgentId != null &&
        (!start || saleAt(b) >= start) &&
        (!endExclusive || saleAt(b) < endExclusive)
    );
    const byAgent = new Map<string, { agentId: string; fullName: string; role: string; profit: number; bookingCount: number }>();
    for (const b of eligible) {
      const agent = agents.get(b.sentByAgentId!);
      if (!agent) continue; // INNER JOIN Account — no matching account row
      if (filtersHidden && agent.accountsVisible === false) continue;
      const existing = byAgent.get(agent.id);
      if (existing) {
        existing.profit += b.profitAmount!;
        existing.bookingCount += 1;
      } else {
        byAgent.set(agent.id, { agentId: agent.id, fullName: agent.fullName, role: agent.role, profit: b.profitAmount!, bookingCount: 1 });
      }
    }
    return [...byAgent.values()];
  }),
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));

beforeEach(() => {
  bookings = [];
  agents = new Map();
  vi.clearAllMocks();
});

describe("getSalesboard — DB-side aggregation (Pass 24)", () => {
  it("returns [] for a null viewer without querying the database", async () => {
    const { getSalesboard } = await import("../salesboard");
    const result = await getSalesboard(null, "all");
    expect(result).toEqual([]);
    expect(fakePrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("sums profit and counts bookings correctly across MULTIPLE bookings for the same agent — not just one row", async () => {
    agents.set("agent-1", { id: "agent-1", fullName: "Andrew Kent", role: "TRAVEL_AGENT" });
    bookings = [
      { id: "b1", status: "CONFIRMED", profitAmount: 100, updatedAt: new Date(), companyId: "company-1", sentByAgentId: "agent-1" },
      { id: "b2", status: "CONFIRMED", profitAmount: 250, updatedAt: new Date(), companyId: "company-1", sentByAgentId: "agent-1" },
      { id: "b3", status: "CONFIRMED", profitAmount: 50, updatedAt: new Date(), companyId: "company-1", sentByAgentId: "agent-1" },
    ];
    const { getSalesboard } = await import("../salesboard");
    const result = await getSalesboard({ id: "viewer-1", role: "ADMIN", companyId: "company-1" }, "all");
    expect(result).toEqual([{ id: "agent-1", fullName: "Andrew Kent", role: "Travel Agent", profit: 400, bookingCount: 3 }]);
  });

  it("a dataset with MANY bookings across MANY agents still returns exactly one row per agent, correctly summed", async () => {
    // Proves the aggregation is correct at a scale well beyond any single
    // "page" — the whole point of moving this to the database.
    for (let i = 0; i < 5; i++) {
      agents.set(`agent-${i}`, { id: `agent-${i}`, fullName: `Agent ${i}`, role: "TRAVEL_AGENT" });
    }
    for (let i = 0; i < 250; i++) {
      const agentId = `agent-${i % 5}`;
      bookings.push({ id: `b${i}`, status: "CONFIRMED", profitAmount: 10, updatedAt: new Date(), companyId: "company-1", sentByAgentId: agentId });
    }
    const { getSalesboard } = await import("../salesboard");
    const result = await getSalesboard({ id: "viewer-1", role: "ADMIN", companyId: "company-1" }, "all");
    expect(result).toHaveLength(5); // one row per agent, never per booking
    for (const row of result) {
      expect(row.profit).toBe(500); // 50 bookings × $10 each
      expect(row.bookingCount).toBe(50);
    }
  });

  it("excludes a booking whose quote has no recorded sender (sentByAgentId null) — matches the pre-Pass-24 `if (!agent) continue` behavior", async () => {
    bookings = [{ id: "b1", status: "CONFIRMED", profitAmount: 500, updatedAt: new Date(), companyId: "company-1", sentByAgentId: null }];
    const { getSalesboard } = await import("../salesboard");
    const result = await getSalesboard({ id: "viewer-1", role: "ADMIN", companyId: "company-1" }, "all");
    expect(result).toEqual([]);
  });

  it("never includes a booking from a DIFFERENT company, even with an identical agent id collision", async () => {
    agents.set("agent-1", { id: "agent-1", fullName: "Andrew Kent", role: "TRAVEL_AGENT" });
    bookings = [
      { id: "b1", status: "CONFIRMED", profitAmount: 100, updatedAt: new Date(), companyId: "company-1", sentByAgentId: "agent-1" },
      { id: "b2", status: "CONFIRMED", profitAmount: 999, updatedAt: new Date(), companyId: "company-OTHER", sentByAgentId: "agent-1" },
    ];
    const { getSalesboard } = await import("../salesboard");
    const result = await getSalesboard({ id: "viewer-1", role: "ADMIN", companyId: "company-1" }, "all");
    expect(result).toEqual([{ id: "agent-1", fullName: "Andrew Kent", role: "Travel Agent", profit: 100, bookingCount: 1 }]);
  });

  it("excludes a non-CONFIRMED booking and a booking with a null profitAmount", async () => {
    agents.set("agent-1", { id: "agent-1", fullName: "Andrew Kent", role: "TRAVEL_AGENT" });
    bookings = [
      { id: "b1", status: "TICKETED", profitAmount: 100, updatedAt: new Date(), companyId: "company-1", sentByAgentId: "agent-1" },
      { id: "b2", status: "CONFIRMED", profitAmount: null, updatedAt: new Date(), companyId: "company-1", sentByAgentId: "agent-1" },
    ];
    const { getSalesboard } = await import("../salesboard");
    const result = await getSalesboard({ id: "viewer-1", role: "ADMIN", companyId: "company-1" }, "all");
    expect(result).toEqual([]);
  });

  it("a period filter (e.g. 'today') excludes an older booking that an 'all time' view would include", async () => {
    agents.set("agent-1", { id: "agent-1", fullName: "Andrew Kent", role: "TRAVEL_AGENT" });
    bookings = [
      { id: "old", status: "CONFIRMED", profitAmount: 500, updatedAt: new Date("2020-01-01"), companyId: "company-1", sentByAgentId: "agent-1" },
      { id: "recent", status: "CONFIRMED", profitAmount: 300, updatedAt: new Date(), companyId: "company-1", sentByAgentId: "agent-1" },
    ];
    const { getSalesboard } = await import("../salesboard");
    const allTime = await getSalesboard({ id: "viewer-1", role: "ADMIN", companyId: "company-1" }, "all");
    expect(allTime[0].profit).toBe(800);

    const today = await getSalesboard({ id: "viewer-1", role: "ADMIN", companyId: "company-1" }, "today");
    expect(today[0].profit).toBe(300);
  });

  it("sorts by profit descending regardless of the order rows come back in", async () => {
    agents.set("low", { id: "low", fullName: "Low Earner", role: "TRAVEL_AGENT" });
    agents.set("high", { id: "high", fullName: "High Earner", role: "TRAVEL_AGENT" });
    bookings = [
      { id: "b1", status: "CONFIRMED", profitAmount: 50, updatedAt: new Date(), companyId: "company-1", sentByAgentId: "low" },
      { id: "b2", status: "CONFIRMED", profitAmount: 5000, updatedAt: new Date(), companyId: "company-1", sentByAgentId: "high" },
    ];
    const { getSalesboard } = await import("../salesboard");
    const result = await getSalesboard({ id: "viewer-1", role: "ADMIN", companyId: "company-1" }, "all");
    expect(result.map((r) => r.id)).toEqual(["high", "low"]);
  });
});

describe("getSalesboard — hidden accounts are not shown as current salespeople", () => {
  const VIEWER = { id: "viewer-1", role: "ADMIN" as const, companyId: "company-1" };
  const booking = (id: string, agentId: string, profit: number): FakeBooking => ({ id, status: "CONFIRMED", profitAmount: profit, updatedAt: new Date(), companyId: "company-1", sentByAgentId: agentId });

  it("a hidden user does not appear; a visible user still does, with the same figures", async () => {
    agents.set("visible", { id: "visible", fullName: "Visible Vic", role: "TRAVEL_AGENT", accountsVisible: true });
    agents.set("hidden", { id: "hidden", fullName: "Hidden Hal", role: "TRAVEL_AGENT", accountsVisible: false });
    bookings = [booking("b1", "visible", 300), booking("b2", "hidden", 900)];
    const { getSalesboard } = await import("../salesboard");
    const rows = await getSalesboard(VIEWER, "all");
    expect(rows.map((r) => r.fullName)).toEqual(["Visible Vic"]);
    expect(rows[0]).toMatchObject({ profit: 300, bookingCount: 1 });
  });

  it("applies in every period, not only All Time", async () => {
    agents.set("hidden", { id: "hidden", fullName: "Hidden Hal", role: "TRAVEL_AGENT", accountsVisible: false });
    bookings = [booking("b1", "hidden", 900)];
    const { getSalesboard } = await import("../salesboard");
    for (const period of ["today", "week", "month", "year", "all"] as const) {
      expect(await getSalesboard(VIEWER, period), period).toEqual([]);
    }
  });

  it("hiding is not deleting: the hidden user's booking is untouched, and un-hiding brings the same figures straight back", async () => {
    agents.set("hal", { id: "hal", fullName: "Hidden Hal", role: "TRAVEL_AGENT", accountsVisible: false });
    bookings = [booking("b1", "hal", 900)];
    const { getSalesboard } = await import("../salesboard");
    expect(await getSalesboard(VIEWER, "all")).toEqual([]);
    expect(bookings).toHaveLength(1);
    agents.get("hal")!.accountsVisible = true;
    expect(await getSalesboard(VIEWER, "all")).toEqual([{ id: "hal", fullName: "Hidden Hal", role: "Travel Agent", profit: 900, bookingCount: 1 }]);
  });

  it("hidden is distinct from inactive: an inactive-but-visible account is not filtered by this rule", async () => {
    agents.set("gone", { id: "gone", fullName: "Gone Gus", role: "TRAVEL_AGENT", accountsVisible: true, status: "INACTIVE" });
    bookings = [booking("b1", "gone", 120)];
    const { getSalesboard } = await import("../salesboard");
    expect((await getSalesboard(VIEWER, "all")).map((r) => r.fullName)).toEqual(["Gone Gus"]);
  });

  it("the query itself carries the shared visibility predicate (both the period and all-time variants)", async () => {
    const { getSalesboard } = await import("../salesboard");
    await getSalesboard(VIEWER, "all");
    await getSalesboard(VIEWER, "month");
    for (const call of fakePrisma.$queryRaw.mock.calls) {
      expect((call[0] as unknown as { sql: string }).sql).toContain('a."accountsVisible" = true');
    }
  });
});
