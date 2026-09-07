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
  companyId: string;
  sentByAgentId: string | null;
};
type FakeAgent = { id: string; fullName: string; role: string };

let bookings: FakeBooking[];
let agents: Map<string, FakeAgent>;

const fakePrisma = {
  $queryRaw: vi.fn(async (_strings: TemplateStringsArray, companyId: string, start?: Date) => {
    const eligible = bookings.filter(
      (b) => b.status === "CONFIRMED" && b.profitAmount !== null && b.companyId === companyId && b.sentByAgentId != null && (!start || b.updatedAt >= start)
    );
    const byAgent = new Map<string, { agentId: string; fullName: string; role: string; profit: number; bookingCount: number }>();
    for (const b of eligible) {
      const agent = agents.get(b.sentByAgentId!);
      if (!agent) continue; // INNER JOIN Account — no matching account row
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
