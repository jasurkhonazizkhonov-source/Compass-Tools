// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of pay-period reporting: the Salesboard and Commissions queries filter on the SAME sale date (the booking's
// confirmation event) using exact business-zone instants, so every sale lands in exactly one official pay period, a closed period
// never changes afterwards, hidden users / other companies / other agents never leak in through a date filter, and the commission
// math is unchanged. Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

const TAG = `pp-${Date.now()}`;

describe.skipIf(!enabled)("pay-period Salesboard & Commissions — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let getSalesboard: typeof import("@/server/queries/salesboard").getSalesboard;
  let getCommissions: typeof import("@/server/queries/commissions").getCommissions;
  let getCommissionsSummary: typeof import("@/server/queries/commissions").getCommissionsSummary;
  let toSalesRange: typeof import("@/server/queries/sales-range").toSalesRange;
  let resolveReportRange: typeof import("@/lib/pay-period").resolveReportRange;
  let payPeriodContaining: typeof import("@/lib/pay-period").payPeriodContaining;

  const companyId = `co-${TAG}`;
  const otherCompanyId = `co2-${TAG}`;
  const ids = { accounts: [] as string[], contacts: [] as string[] };
  let seq = 0;
  const acct: Record<string, { id: string; role: "ADMIN" | "MANAGER" | "TRAVEL_AGENT"; companyId: string }> = {};

  const viewer = (name: string) => acct[name];
  const periodRange = (key: string) => toSalesRange(resolveReportRange({ payPeriod: key }));
  const customRange = (from: string, to: string) => toSalesRange(resolveReportRange({ from, to }));
  const board = async (name: string, range: ReturnType<typeof toSalesRange>) => (await getSalesboard(viewer(name), range)).map((r) => `${r.fullName}:${r.bookingCount}:${r.profit}`).sort();

  async function makeAccount(name: string, role: "ADMIN" | "MANAGER" | "TRAVEL_AGENT", extra: { commissionPercent?: number; accountsVisible?: boolean; company?: string } = {}) {
    const a = await prisma.account.create({
      data: { fullName: `${name}`, email: `${name.toLowerCase()}-${TAG}@example.test`, role, status: "ACTIVE", companyId: extra.company ?? companyId, commissionPercent: extra.commissionPercent, accountsVisible: extra.accountsVisible ?? true },
    });
    ids.accounts.push(a.id);
    acct[name] = { id: a.id, role, companyId: a.companyId };
  }

  /** contact → lead → quote → booking. `confirmedAt` writes the CONFIRMED status-history row (the sale date); omit for a legacy booking with no history. */
  async function sale(opts: { agent: string; profit: number | null; confirmedAt?: string; status?: "CONFIRMED" | "TICKETED"; updatedAt?: string; company?: string }) {
    const n = ++seq;
    const company = opts.company ?? companyId;
    const contact = await prisma.contact.create({ data: { firstName: "C", lastName: `${TAG}-${n}`, primaryEmail: `c${n}-${TAG}@example.test`, primaryPhone: `+1415556${String(1000 + n)}`, companyId: company } });
    ids.contacts.push(contact.id);
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "QUOTED", source: "OTHER", assignedAgentId: acct[opts.agent].id } });
    const quote = await prisma.quote.create({
      data: { quoteNumber: `Q-${TAG}-${n}`, secureToken: `tok-${TAG}-${n}`, leadId: lead.id, contactId: contact.id, agentId: acct[opts.agent].id, sentByAgentId: acct[opts.agent].id, status: "SENT", adults: 1, adultPrice: 500, taxes: 0, serviceFee: 0, total: 500 },
    });
    const booking = await prisma.booking.create({
      data: {
        quoteId: quote.id, leadId: lead.id, contactId: contact.id, bookingReference: `BK-${TAG}-${n}`.slice(0, 30), contactPhone: "+14155550000", contactEmail: contact.primaryEmail!,
        billingAddress: "1 Test St", billingCity: "Springfield", billingState: "IL", billingZip: "62704", billingCountry: "US",
        status: opts.status ?? "CONFIRMED", profitAmount: opts.profit ?? undefined,
      },
    });
    if (opts.confirmedAt) await prisma.bookingStatusHistory.create({ data: { bookingId: booking.id, fromStatus: "TICKETED", toStatus: "CONFIRMED", changedAt: new Date(opts.confirmedAt) } });
    if (opts.updatedAt) await prisma.$executeRaw`UPDATE "Booking" SET "updatedAt" = ${new Date(opts.updatedAt)} WHERE "id" = ${booking.id}`;
    return booking.id;
  }

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ getSalesboard } = await import("@/server/queries/salesboard"));
    ({ getCommissions, getCommissionsSummary } = await import("@/server/queries/commissions"));
    ({ toSalesRange } = await import("@/server/queries/sales-range"));
    ({ resolveReportRange, payPeriodContaining } = await import("@/lib/pay-period"));
    for (const id of [companyId, otherCompanyId]) await prisma.company.create({ data: { id, name: `Co ${id}`, signatureTemplate: "Regards" } });
    await makeAccount("Admin", "ADMIN");
    await makeAccount("Manager", "MANAGER", { commissionPercent: 5 });
    await makeAccount("Alice", "TRAVEL_AGENT", { commissionPercent: 10 });
    await makeAccount("Bob", "TRAVEL_AGENT", { commissionPercent: 20 });
    await makeAccount("Hidden", "TRAVEL_AGENT", { commissionPercent: 10, accountsVisible: false });
    await makeAccount("Outsider", "TRAVEL_AGENT", { commissionPercent: 10, company: otherCompanyId });
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.contact.deleteMany({ where: { id: { in: ids.contacts } } }); // cascades lead/quote/booking/history
    await prisma.account.deleteMany({ where: { id: { in: ids.accounts } } });
    await prisma.company.deleteMany({ where: { id: { in: [companyId, otherCompanyId] } } });
    await prisma.$disconnect();
  });

  // ------------------------------------------------------------------------------------------------------------------------
  describe("the exact boundaries (America/Los_Angeles, DST-aware)", () => {
    // One $100 sale for Alice at each edge. Pacific: PDT (UTC-7) until Nov 1 2026, PST (UTC-8) after.
    const edges: Record<string, { at: string; period: string }> = {
      oct20_2359: { at: "2026-10-21T06:59:59Z", period: "2026-10-P2" }, //  Oct 20 23:59:59 PDT → Period 2 (Oct 6–20)
      oct21_0000: { at: "2026-10-21T07:00:00Z", period: "2026-11-P1" }, //  Oct 21 00:00:00 PDT → Period 1 (Oct 21–Nov 5)
      nov05_2359: { at: "2026-11-06T07:59:59Z", period: "2026-11-P1" }, //  Nov  5 23:59:59 PST → still Period 1 (already Nov 6 in UTC!)
      nov06_0000: { at: "2026-11-06T08:00:00Z", period: "2026-11-P2" }, //  Nov  6 00:00:00 PST → Period 2
      nov20_2359: { at: "2026-11-21T07:59:59Z", period: "2026-11-P2" }, //  Nov 20 23:59:59 PST → Period 2
      nov21_0000: { at: "2026-11-21T08:00:00Z", period: "2026-12-P1" }, //  Nov 21 00:00:00 PST → next Period 1
      dec31_2000: { at: "2027-01-01T04:00:00Z", period: "2027-01-P1" }, //  Dec 31 20:00 PST → January's Period 1 (year boundary)
      jan05_2359: { at: "2027-01-06T07:59:59Z", period: "2027-01-P1" }, //  Jan  5 23:59:59 PST → still Period 1
      jan06_0000: { at: "2027-01-06T08:00:00Z", period: "2027-01-P2" }, //  Jan  6 00:00:00 PST → Period 2
    };
    const saleIds: Record<string, string> = {};

    beforeAll(async () => {
      for (const [k, e] of Object.entries(edges)) saleIds[k] = await sale({ agent: "Alice", profit: 100, confirmedAt: e.at });
    });

    it("every edge sale appears in exactly ONE pay period — the one the calendar says — and in no other", async () => {
      const periodKeys = [...new Set(Object.values(edges).map((e) => e.period))];
      for (const [name, e] of Object.entries(edges)) {
        for (const key of periodKeys) {
          const rows = await getSalesboard(viewer("Admin"), periodRange(key));
          const alice = rows.find((r) => r.fullName === "Alice");
          const expectedHere = Object.entries(edges).filter(([, x]) => x.period === key).length;
          expect(alice?.bookingCount ?? 0, `${key} (checking ${name})`).toBe(expectedHere);
        }
        // and the pure calendar agrees with where the database put it
        const civil = (await import("@/lib/pay-period")).civilDateInZone(new Date(e.at));
        expect(payPeriodContaining(civil).key, name).toBe(e.period);
      }
    });

    it("the 5th belongs to Period 1, the 6th to Period 2, the 20th to Period 2 and the 21st to the NEXT Period 1 — in commissions too", async () => {
      const keysFor = async (period: string) => {
        const { rows } = await getCommissions(viewer("Admin"), { range: periodRange(period) }, 1, 100);
        return rows.map((r) => r.bookingId);
      };
      const p1 = await keysFor("2026-11-P1");
      expect(p1).toContain(saleIds.oct21_0000);
      expect(p1).toContain(saleIds.nov05_2359);
      expect(p1).not.toContain(saleIds.nov06_0000);
      const p2 = await keysFor("2026-11-P2");
      expect(p2).toEqual(expect.arrayContaining([saleIds.nov06_0000, saleIds.nov20_2359]));
      expect(p2).not.toContain(saleIds.nov21_0000);
      expect(p2).not.toContain(saleIds.nov05_2359);
      const next = await keysFor("2026-12-P1");
      expect(next).toContain(saleIds.nov21_0000);
    });

    it("the year boundary: December 21 → January 5 is January's Period 1 and carries no December/previous-year leakage", async () => {
      const jan1 = await getCommissions(viewer("Admin"), { range: periodRange("2027-01-P1") }, 1, 100);
      expect(jan1.rows.map((r) => r.bookingId).sort()).toEqual([saleIds.dec31_2000, saleIds.jan05_2359].sort());
      const jan2 = await getCommissions(viewer("Admin"), { range: periodRange("2027-01-P2") }, 1, 100);
      expect(jan2.rows.map((r) => r.bookingId)).toEqual([saleIds.jan06_0000]);
    });

    it("the Salesboard and the Commissions page count the SAME bookings for the same range", async () => {
      for (const key of ["2026-10-P2", "2026-11-P1", "2026-11-P2", "2026-12-P1", "2027-01-P1", "2027-01-P2"]) {
        const range = periodRange(key);
        const alice = (await getSalesboard(viewer("Admin"), range)).find((r) => r.fullName === "Alice");
        const summary = await getCommissionsSummary(viewer("Admin"), { userId: acct.Alice.id, range });
        expect(summary.bookingCount, key).toBe(alice?.bookingCount ?? 0);
        expect(summary.totalProfit, key).toBe(alice?.profit ?? 0);
      }
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------
  describe("the sale date is the CONFIRMATION event — later edits never move a sale between periods", () => {
    it("touching a confirmed booking after its period closed (updatedAt jumps forward) leaves it in its original period", async () => {
      const id = await sale({ agent: "Bob", profit: 300, confirmedAt: "2026-03-10T18:00:00Z", updatedAt: "2026-03-10T18:00:00Z" });
      const before = await board("Admin", periodRange("2026-03-P2"));
      expect(before.some((r) => r.startsWith("Bob:1:300"))).toBe(true);
      // someone edits the booking weeks later (ticket numbers, notes, profit recompute …): updatedAt moves, the confirmation does not
      await prisma.$executeRaw`UPDATE "Booking" SET "updatedAt" = ${new Date("2026-05-02T12:00:00Z")} WHERE "id" = ${id}`;
      expect(await board("Admin", periodRange("2026-03-P2"))).toEqual(before);
      expect((await board("Admin", periodRange("2026-05-P1"))).some((r) => r.startsWith("Bob:"))).toBe(false);
      const { rows } = await getCommissions(viewer("Admin"), { userId: acct.Bob.id, range: periodRange("2026-03-P2") }, 1, 50);
      expect(rows.find((r) => r.bookingId === id)?.confirmedAt.toISOString()).toBe("2026-03-10T18:00:00.000Z");
    });

    it("a legacy booking with NO status-history row falls back to its updatedAt, so nothing disappears from reporting", async () => {
      const id = await sale({ agent: "Bob", profit: 70, updatedAt: "2026-04-12T20:00:00Z" });
      const { rows } = await getCommissions(viewer("Admin"), { userId: acct.Bob.id, range: periodRange("2026-04-P2") }, 1, 50);
      expect(rows.map((r) => r.bookingId)).toContain(id);
    });

    it("a booking re-confirmed after being reverted counts on its LATEST confirmation, once", async () => {
      const id = await sale({ agent: "Bob", profit: 55, confirmedAt: "2026-06-07T18:00:00Z" });
      await prisma.bookingStatusHistory.create({ data: { bookingId: id, fromStatus: "CONFIRMED", toStatus: "TICKETED", changedAt: new Date("2026-06-10T18:00:00Z") } });
      await prisma.bookingStatusHistory.create({ data: { bookingId: id, fromStatus: "TICKETED", toStatus: "CONFIRMED", changedAt: new Date("2026-06-25T18:00:00Z") } });
      const early = await getCommissions(viewer("Admin"), { userId: acct.Bob.id, range: periodRange("2026-06-P2") }, 1, 50);
      const late = await getCommissions(viewer("Admin"), { userId: acct.Bob.id, range: periodRange("2026-07-P1") }, 1, 50);
      expect(early.rows.map((r) => r.bookingId)).not.toContain(id);
      expect(late.rows.filter((r) => r.bookingId === id)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------
  describe("no double counting, no gaps, history stays stable", () => {
    const START = "2027-02-01"; // a quiet stretch with deterministic data: one $10 sale a day for Alice and one $20 sale a day for Bob
    const DAYS = 90;

    beforeAll(async () => {
      for (let i = 0; i < DAYS; i++) {
        const day = new Date(Date.UTC(2027, 1, 1 + i, 20, 0, 0)); // 12:00 PST that day
        await sale({ agent: "Alice", profit: 10, confirmedAt: day.toISOString() });
        await sale({ agent: "Bob", profit: 20, confirmedAt: day.toISOString() });
      }
    });

    it("consecutive pay periods PARTITION the time line: their totals add up to the whole, with every day in exactly one", async () => {
      const { payPeriodContaining: pc, addDays, previousPayPeriod, nextPayPeriod, compareCivil } = await import("@/lib/pay-period");
      const from = { year: 2027, month: 2, day: 1 };
      const to = addDays(from, DAYS - 1);
      let p = pc(from);
      let totalCount = 0;
      let totalProfit = 0;
      while (compareCivil(p.start, to) <= 0) {
        const s = await getCommissionsSummary(viewer("Admin"), { range: toSalesRange(resolveReportRange({ payPeriod: p.key })) });
        // only the 90 seeded days (outside them the quiet-stretch data is absent; earlier suites' sales are in other periods)
        const lo = compareCivil(p.start, from) < 0 ? from : p.start;
        const hi = compareCivil(p.end, to) > 0 ? to : p.end;
        const daysInside = (Date.UTC(hi.year, hi.month - 1, hi.day) - Date.UTC(lo.year, lo.month - 1, lo.day)) / 86_400_000 + 1;
        expect(s.bookingCount, p.key).toBe(daysInside * 2);
        expect(s.totalProfit, p.key).toBe(daysInside * 30);
        totalCount += s.bookingCount;
        totalProfit += s.totalProfit;
        p = nextPayPeriod(p);
      }
      expect(totalCount).toBe(DAYS * 2);
      expect(totalProfit).toBe(DAYS * 30);
      expect(previousPayPeriod(nextPayPeriod(pc(from))).key).toBe(pc(from).key);
      // the same window as ONE custom range gives the same answer (a custom range uses the same engine, not a second one)
      const whole = await getCommissionsSummary(viewer("Admin"), { range: customRange(START, toIso(addDays(from, DAYS - 1))) });
      expect(whole.bookingCount).toBe(DAYS * 2);
      expect(whole.totalProfit).toBe(DAYS * 30);
    });

    it("switching between periods and re-running the same query never duplicates or drifts", async () => {
      const a = await getCommissionsSummary(viewer("Admin"), { range: periodRange("2027-03-P1") });
      await getCommissionsSummary(viewer("Admin"), { range: periodRange("2027-03-P2") });
      await getSalesboard(viewer("Admin"), periodRange("2027-03-P2"));
      const b = await getCommissionsSummary(viewer("Admin"), { range: periodRange("2027-03-P1") });
      expect(b).toEqual(a);
    });

    it("a closed period's totals are identical after NEW sales are created in later periods (commission history is stable)", async () => {
      const before = await getCommissionsSummary(viewer("Admin"), { range: periodRange("2027-03-P2") });
      const boardBefore = await board("Admin", periodRange("2027-03-P2"));
      await sale({ agent: "Alice", profit: 999, confirmedAt: "2027-06-15T20:00:00Z" });
      await sale({ agent: "Alice", profit: 999, confirmedAt: new Date().toISOString() });
      expect(await getCommissionsSummary(viewer("Admin"), { range: periodRange("2027-03-P2") })).toEqual(before);
      expect(await board("Admin", periodRange("2027-03-P2"))).toEqual(boardBefore);
    });

    it("a new period starts at ZERO without any reset: a period with no confirmed sales shows an empty board and zero commission, and nothing was deleted", async () => {
      const empty = periodRange("2030-01-P2");
      expect(await getSalesboard(viewer("Admin"), empty)).toEqual([]);
      expect(await getCommissionsSummary(viewer("Admin"), { range: empty })).toMatchObject({ bookingCount: 0, totalCommission: 0, totalEarnings: 0 });
      // …while the earlier history is all still there
      expect((await getCommissionsSummary(viewer("Admin"), { range: toSalesRange({ kind: "all", isCurrentPayPeriod: false, label: "All time" }) })).bookingCount).toBeGreaterThan(DAYS * 2);
    });

    it("custom From/To is inclusive of both end days and exclusive of the days around it", async () => {
      const r = await getCommissionsSummary(viewer("Admin"), { userId: acct.Alice.id, range: customRange("2027-02-10", "2027-02-12") });
      expect(r.bookingCount).toBe(3); // the 10th, 11th and 12th
      expect(r.totalProfit).toBe(30);
      const one = await getCommissionsSummary(viewer("Admin"), { userId: acct.Alice.id, range: customRange("2027-02-10", "2027-02-10") });
      expect(one.bookingCount).toBe(1);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------
  describe("commission math is unchanged — only WHICH period a sale lands in is new", () => {
    it("commission = profit × the agent's rate, summed over the period, per agent", async () => {
      await sale({ agent: "Alice", profit: 200, confirmedAt: "2027-09-10T20:00:00Z" }); // Alice 10%
      await sale({ agent: "Alice", profit: 100, confirmedAt: "2027-09-12T20:00:00Z" });
      await sale({ agent: "Bob", profit: 500, confirmedAt: "2027-09-11T20:00:00Z" }); // Bob 20%
      const range = periodRange("2027-09-P2");
      const alice = await getCommissionsSummary(viewer("Alice"), { range });
      expect(alice).toMatchObject({ bookingCount: 2, totalProfit: 300, totalCommission: 30 });
      const bob = await getCommissionsSummary(viewer("Bob"), { range });
      expect(bob).toMatchObject({ bookingCount: 1, totalProfit: 500, totalCommission: 100 });
      const all = await getCommissionsSummary(viewer("Admin"), { range });
      expect(all).toMatchObject({ bookingCount: 3, totalProfit: 800, totalCommission: 130 });
    });

    it("an unconfirmed booking, or one with no profit, never counts — in any period", async () => {
      await sale({ agent: "Alice", profit: 400, status: "TICKETED", confirmedAt: "2027-10-10T20:00:00Z" });
      await sale({ agent: "Alice", profit: null, confirmedAt: "2027-10-11T20:00:00Z" });
      const range = periodRange("2027-10-P2");
      expect(await getSalesboard(viewer("Admin"), range)).toEqual([]);
      expect((await getCommissionsSummary(viewer("Admin"), { range })).bookingCount).toBe(0);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------
  describe("a date filter is never an authorization filter", () => {
    const range = () => periodRange("2027-11-P2");
    beforeAll(async () => {
      await sale({ agent: "Alice", profit: 100, confirmedAt: "2027-11-10T20:00:00Z" });
      await sale({ agent: "Bob", profit: 200, confirmedAt: "2027-11-10T20:00:00Z" });
      await sale({ agent: "Hidden", profit: 900, confirmedAt: "2027-11-10T20:00:00Z" });
      await sale({ agent: "Outsider", profit: 5000, confirmedAt: "2027-11-10T20:00:00Z", company: otherCompanyId });
      await sale({ agent: "Manager", profit: 300, confirmedAt: "2027-11-10T20:00:00Z" });
    });

    it("a Travel Agent sees only their OWN commissions whatever dates and user id they ask for", async () => {
      for (const asked of [{}, { userId: acct.Bob.id }, { userId: acct.Hidden.id }, { userId: "someone-else" }]) {
        const alice = await getCommissionsSummary(viewer("Alice"), { ...asked, range: range() });
        expect(alice, JSON.stringify(asked)).toMatchObject({ bookingCount: 1, totalProfit: 100 });
        const list = await getCommissions(viewer("Alice"), { ...asked, range: range() }, 1, 50);
        expect(list.rows.every((r) => r.quoteOwnerId === acct.Alice.id)).toBe(true);
      }
      // all-time, and a huge custom range, are still only their own
      const huge = await getCommissionsSummary(viewer("Alice"), { range: customRange("2000-01-01", "2100-12-31") });
      const everyone = await getCommissionsSummary(viewer("Admin"), { range: customRange("2000-01-01", "2100-12-31") });
      expect(huge.bookingCount).toBeLessThan(everyone.bookingCount);
    });

    it("a Manager sees only their own commissions (the existing rule), not their team's or the company's", async () => {
      const m = await getCommissionsSummary(viewer("Manager"), { userId: acct.Alice.id, range: range() });
      expect(m).toMatchObject({ bookingCount: 1, totalProfit: 300 });
    });

    it("another company's sales never appear, for any role or range", async () => {
      for (const who of ["Admin", "Manager", "Alice"]) {
        const everything = await getCommissions(viewer(who), { range: customRange("2000-01-01", "2100-12-31") }, 1, 1000);
        expect(everything.rows.some((r) => r.profit === 5000), who).toBe(false);
      }
      expect((await getSalesboard(viewer("Admin"), range())).some((r) => r.fullName === "Outsider")).toBe(false);
      const theirs = await getSalesboard(viewer("Outsider"), range());
      expect(theirs.map((r) => r.fullName)).toEqual(["Outsider"]);
    });

    it("hidden users stay off the Salesboard in EVERY range (current, previous, custom, all) — their sales are not deleted and stay in Admin commissions", async () => {
      const ranges = [range(), periodRange("2027-11-P1"), customRange("2027-11-01", "2027-11-30"), customRange("2000-01-01", "2100-12-31"), toSalesRange({ kind: "all", isCurrentPayPeriod: false, label: "All" })];
      for (const r of ranges) expect((await getSalesboard(viewer("Admin"), r)).some((row) => row.fullName === "Hidden")).toBe(false);
      // …and still visible to Admin commissions (all users), exactly as before pay periods existed
      const adminAll = await getCommissionsSummary(viewer("Admin"), { range: range() });
      expect(adminAll.totalProfit).toBe(100 + 200 + 900 + 300);
      expect((await getCommissionsSummary(viewer("Admin"), { userId: acct.Hidden.id, range: range() })).bookingCount).toBe(1);
    });

    it("the Salesboard is still company-wide for every signed-in role (the existing design), showing only visible agents", async () => {
      for (const who of ["Admin", "Manager", "Alice"]) {
        const names = (await getSalesboard(viewer(who), range())).map((r) => r.fullName).sort();
        expect(names, who).toEqual(["Alice", "Bob", "Manager"]);
      }
    });
  });
});

function toIso(c: { year: number; month: number; day: number }) {
  return `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
}
