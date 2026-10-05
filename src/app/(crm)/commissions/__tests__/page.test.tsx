import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getCommissions = vi.fn();
const getCommissionsSummary = vi.fn();
vi.mock("@/server/queries/commissions", () => ({ getCommissions: (...a: unknown[]) => getCommissions(...a), getCommissionsSummary: (...a: unknown[]) => getCommissionsSummary(...a) }));
vi.mock("@/server/queries/reference-data", () => ({ listLeadEligibleAgents: vi.fn(async () => [{ id: "u1", fullName: "Alice" }, { id: "u2", fullName: "Bob" }]) }));
let account: { id: string; role: string; companyId: string } | null = { id: "u1", role: "TRAVEL_AGENT", companyId: "c1" };
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => account) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: vi.fn(),
}));
vi.mock("@/components/crm/pagination-controls", () => ({ PaginationControls: () => null }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import CommissionsPage from "../page";

const SUMMARY = { bookingCount: 2, totalProfit: 500, totalCommission: 50, totalTips: 0, tipEarnings: 0, totalEarnings: 50, uniformTipPercent: 10 };
const ROW = {
  bookingId: "b1", bookingReference: "BK-1", quoteId: "q1", quoteNumber: "Q-1", customerName: "Jane Doe", transactionType: "NEW_SALE" as const,
  profit: 250, commissionPercent: 10, commissionAmount: 25, tipPercent: 0, grossTip: 0, tipEarned: 0, quoteOwnerId: "u1", quoteOwnerName: "Alice", ticketingAgentName: "Tess",
  destination: "Paris, France", status: "CONFIRMED", confirmedAt: new Date("2026-11-06T07:59:00Z"), // 23:59 on Nov 5, Pacific
};
async function render(sp: Record<string, string> = {}) {
  return renderToStaticMarkup(await CommissionsPage({ searchParams: Promise.resolve(sp) }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  getCommissions.mockReset();
  getCommissionsSummary.mockReset();
  getCommissions.mockResolvedValue({ rows: [ROW], total: 1, page: 1, pageSize: 25, pageCount: 1 });
  getCommissionsSummary.mockResolvedValue(SUMMARY);
  account = { id: "u1", role: "TRAVEL_AGENT", companyId: "c1" };
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T20:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("Commissions page — period-aware", () => {
  it("defaults to the CURRENT pay period and says so: 'Current Period Commission' with the exact dates", async () => {
    const html = await render();
    expect(html).toContain('data-testid="commission-summary-title"');
    expect(text(html)).toContain("Current Period Commission");
    expect(text(html)).toContain("Pay Period 2 · Nov 6 – Nov 20, 2026");
    const filters = getCommissions.mock.calls[0][1] as { range: { start: Date; endExclusive: Date } };
    expect(filters.range.start.toISOString()).toBe("2026-11-06T08:00:00.000Z");
    expect(filters.range.endExclusive.toISOString()).toBe("2026-11-21T08:00:00.000Z");
  });

  it("a custom From/To is labelled 'Custom Range Commission' — never mistaken for the active commission", async () => {
    const t = text(await render({ from: "2026-01-01", to: "2026-03-31" }));
    expect(t).toContain("Custom Range Commission");
    expect(t).not.toContain("Current Period Commission");
    expect(t).toContain("Jan 1 – Mar 31, 2026");
  });

  it("the previous pay period is labelled 'Previous Period Commission'", async () => {
    const t = text(await render({ period: "previous-pay-period" }));
    expect(t).toContain("Previous Period Commission");
    expect(t).toContain("Oct 21 – Nov 5, 2026");
  });

  it("the commission figures follow the selected range, and the comparison asks for the previous equivalent period", async () => {
    await render();
    expect(getCommissionsSummary).toHaveBeenCalledTimes(2);
    const previous = getCommissionsSummary.mock.calls[1][1] as { range: { start: Date; endExclusive: Date } };
    expect(previous.range.start.toISOString()).toBe("2026-10-21T07:00:00.000Z");
    expect(previous.range.endExclusive.toISOString()).toBe("2026-11-06T08:00:00.000Z");
  });

  it("shows the sale date in the BUSINESS zone: a sale confirmed at 23:59 on the 5th (Pacific) reads Nov 5, not Nov 6", async () => {
    expect(text(await render({ period: "previous-pay-period" }))).toContain("Nov 5, 2026");
  });

  it("no previous equivalent for All Time; a zero previous period never yields Infinity/NaN", async () => {
    getCommissionsSummary.mockReset();
    getCommissionsSummary.mockResolvedValueOnce(SUMMARY).mockResolvedValueOnce({ ...SUMMARY, bookingCount: 0, totalProfit: 0, totalCommission: 0, totalEarnings: 0 });
    const t = text(await render());
    expect(t).not.toMatch(/Infinity|NaN/);
    expect(t).toContain("No earlier figure to compare");
  });

  it("an empty period shows an empty state that points at earlier pay periods", async () => {
    getCommissions.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25, pageCount: 1 });
    getCommissionsSummary.mockResolvedValue({ ...SUMMARY, bookingCount: 0, totalProfit: 0, totalCommission: 0, totalEarnings: 0 });
    expect(text(await render())).toContain("No commissions in this period");
  });
});

describe("Commissions page — a date filter is not an authorization filter", () => {
  it("a Travel Agent cannot pick another user: the page never passes a user id for a restricted viewer, whatever the URL says", async () => {
    await render({ user: "u2", period: "all" });
    expect((getCommissions.mock.calls[0][1] as { userId?: string }).userId).toBeUndefined();
    expect((getCommissionsSummary.mock.calls[0][1] as { userId?: string }).userId).toBeUndefined();
  });

  it("the user filter is offered to an Admin only, and its links keep the chosen date range", async () => {
    const agentHtml = await render();
    expect(agentHtml).not.toContain("All Users");
    account = { id: "admin", role: "ADMIN", companyId: "c1" };
    const html = await render({ from: "2026-10-01", to: "2026-10-31" });
    expect(html).toContain("All Users");
    expect(html).toMatch(/href="\/commissions\?[^"]*from=2026-10-01[^"]*to=2026-10-31[^"]*user=u2"/);
  });

  it("an Admin's user filter is honoured and kept when the range changes (hidden inputs on both forms)", async () => {
    account = { id: "admin", role: "ADMIN", companyId: "c1" };
    const html = await render({ user: "u2" });
    expect((getCommissions.mock.calls[0][1] as { userId?: string }).userId).toBe("u2");
    expect(html).toContain('type="hidden" name="user" value="u2"');
  });

  it("signed-out and Ticketing / Flight Expert / Marketing roles still get a 404 (unchanged)", async () => {
    account = null;
    await expect(render()).rejects.toThrow("NOT_FOUND");
    for (const role of ["TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"]) {
      account = { id: "x", role, companyId: "c1" };
      await expect(render(), role).rejects.toThrow("NOT_FOUND");
    }
  });
});
