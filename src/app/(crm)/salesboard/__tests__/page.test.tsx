import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getSalesboard = vi.fn();
vi.mock("@/server/queries/salesboard", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/queries/salesboard")>()), getSalesboard: (...a: unknown[]) => getSalesboard(...a) }));
let account: { id: string; role: string; companyId: string } | null = { id: "a1", role: "TRAVEL_AGENT", companyId: "c1" };
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => account) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import SalesboardPage from "../page";

const ROWS = [
  { id: "a1", fullName: "Alice", role: "Travel Agent", profit: 300, bookingCount: 3 },
  { id: "b1", fullName: "Bob", role: "Travel Agent", profit: 100, bookingCount: 1 },
];
async function render(sp: Record<string, string> = {}) {
  return renderToStaticMarkup(await SalesboardPage({ searchParams: Promise.resolve(sp) }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  getSalesboard.mockReset();
  getSalesboard.mockResolvedValue(ROWS);
  account = { id: "a1", role: "TRAVEL_AGENT", companyId: "c1" };
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("Salesboard page — the current pay period is the default view and flips on its own", () => {
  it("shows Pay Period 2 (6th → 20th) in the middle of the month", async () => {
    vi.setSystemTime(new Date("2026-11-10T20:00:00Z"));
    const html = await render();
    expect(html).toContain('data-testid="salesboard-period"');
    expect(text(html)).toContain("Current Pay Period");
    expect(text(html)).toContain("Pay Period 2 · Nov 6 – Nov 20, 2026");
  });

  it("on the 6th it becomes Period 2, and on the 21st the next month's Period 1 — with no reset or input", async () => {
    vi.setSystemTime(new Date("2026-11-05T20:00:00Z")); // evening of the 5th, Pacific
    expect(text(await render())).toContain("Pay Period 1 · Oct 21 – Nov 5, 2026");
    vi.setSystemTime(new Date("2026-11-06T20:00:00Z"));
    expect(text(await render())).toContain("Pay Period 2 · Nov 6 – Nov 20, 2026");
    vi.setSystemTime(new Date("2026-11-21T20:00:00Z"));
    expect(text(await render())).toContain("Pay Period 1 · Nov 21 – Dec 5, 2026");
  });

  it("queries the database with the EXACT business-zone window of that period (the 5th included, the 6th excluded)", async () => {
    vi.setSystemTime(new Date("2026-11-03T20:00:00Z"));
    await render();
    const range = getSalesboard.mock.calls[0][1] as { start: Date; endExclusive: Date };
    expect(range.start.toISOString()).toBe("2026-10-21T07:00:00.000Z"); // Oct 21 00:00 PDT
    expect(range.endExclusive.toISOString()).toBe("2026-11-06T08:00:00.000Z"); // Nov 6 00:00 PST
  });

  it("also asks for the previous pay period, for the comparison", async () => {
    vi.setSystemTime(new Date("2026-11-10T20:00:00Z"));
    await render();
    expect(getSalesboard).toHaveBeenCalledTimes(2);
    const prev = getSalesboard.mock.calls[1][1] as { start: Date; endExclusive: Date };
    expect(prev.start.toISOString()).toBe("2026-10-21T07:00:00.000Z");
    expect(prev.endExclusive.toISOString()).toBe("2026-11-06T08:00:00.000Z");
  });
});

describe("Salesboard page — From / To and quick selectors use the same query", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-11-10T20:00:00Z")));

  it("a custom From/To is labelled Custom Range and queries exactly those days", async () => {
    const html = await render({ from: "2026-10-01", to: "2026-10-31" });
    expect(text(html)).toContain("Custom Range");
    expect(text(html)).toContain("Oct 1 – Oct 31, 2026");
    const range = getSalesboard.mock.calls[0][1] as { start: Date; endExclusive: Date };
    expect(range.start.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-11-01T07:00:00.000Z"); // Nov 1 00:00 PDT (DST ends later that day)
  });

  it("previous pay period, current/previous month and a chosen historical pay period", async () => {
    expect(text(await render({ period: "previous-pay-period" }))).toContain("Oct 21 – Nov 5, 2026");
    expect(text(await render({ period: "month" }))).toContain("Nov 1 – Nov 30, 2026");
    expect(text(await render({ period: "previous-month" }))).toContain("Oct 1 – Oct 31, 2026");
    expect(text(await render({ payPeriod: "2026-09-P2" }))).toContain("Sep 6 – Sep 20, 2026");
  });

  it("All Time still works and has no previous period to compare with", async () => {
    const html = await render({ period: "all" });
    expect(text(html)).toContain("All Time");
    expect(getSalesboard).toHaveBeenCalledTimes(1);
    expect(getSalesboard.mock.calls[0][1]).toEqual({});
  });

  it("a legacy ?period=today link still resolves", async () => {
    await render({ period: "today" });
    const range = getSalesboard.mock.calls[0][1] as { start: Date; endExclusive: Date };
    expect(range.start.toISOString()).toBe("2026-11-10T08:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2026-11-11T08:00:00.000Z");
  });

  it("bad or reversed dates show a visible warning and fall back to the CURRENT pay period (never an error, never a wider range)", async () => {
    for (const sp of [{ from: "2026-11-20", to: "2026-11-06" }, { from: "garbage", to: "2026-11-06" }, { from: "2026-11-06" }] as Record<string, string>[]) {
      const html = await render(sp);
      expect(html).toContain('data-testid="report-range-warning"');
      expect(text(html)).toContain("Pay Period 2 · Nov 6 – Nov 20, 2026");
    }
  });

  it("renders the From and To inputs, the quick selectors and the pay-period list", async () => {
    const html = await render();
    expect(html).toContain('name="from"');
    expect(html).toContain('name="to"');
    expect(html).toContain('name="payPeriod"');
    for (const label of ["Current Pay Period", "Previous Pay Period", "Current Month", "Previous Month", "This Year", "All Time"]) expect(text(html)).toContain(label);
  });
});

describe("Salesboard page — KPIs and comparison", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-11-10T20:00:00Z")));

  it("totals, average and a percentage change versus the previous period", async () => {
    getSalesboard.mockReset();
    getSalesboard.mockResolvedValueOnce(ROWS).mockResolvedValueOnce([{ id: "a1", fullName: "Alice", role: "Travel Agent", profit: 200, bookingCount: 2 }]);
    const t = text(await render());
    expect(t).toContain("$400.00"); // 300 + 100
    expect(t).toContain("Average Profit per Booking");
    expect(t).toContain("$100.00"); // 400 / 4
    expect(t).toContain("+100.0%"); // 400 vs 200
  });

  it("an empty previous period never produces Infinity/NaN — it says there is nothing to compare with", async () => {
    getSalesboard.mockReset();
    getSalesboard.mockResolvedValueOnce(ROWS).mockResolvedValueOnce([]);
    const t = text(await render());
    expect(t).not.toMatch(/Infinity|NaN/);
    expect(t).toContain("No earlier figure to compare");
  });

  it("an empty current period shows the empty state and a dash for the average (no NaN)", async () => {
    getSalesboard.mockReset();
    getSalesboard.mockResolvedValue([]);
    const t = text(await render());
    expect(t).toContain("No confirmed bookings in this period");
    expect(t).not.toMatch(/NaN|Infinity/);
  });

  it("access is unchanged: a signed-out visitor still gets a 404, every signed-in role is allowed (company-wide board)", async () => {
    account = null;
    await expect(render()).rejects.toThrow("NOT_FOUND");
    for (const role of ["ADMIN", "MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"]) {
      account = { id: "x", role, companyId: "c1" };
      await expect(render(), role).resolves.toContain("Salesboard");
    }
  });
});
