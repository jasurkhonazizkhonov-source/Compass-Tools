import { describe, it, expect } from "vitest";
import {
  addDays,
  BUSINESS_TIMEZONE,
  civilDateInZone,
  civilRangeToInstants,
  compareCivil,
  currentPayPeriod,
  daysBetween,
  daysInMonth,
  formatCivilRange,
  nextPayPeriod,
  parseIsoDate,
  payPeriodContaining,
  payPeriodFromKey,
  payPeriodRangeLabel,
  percentChange,
  previousEquivalentRange,
  previousPayPeriod,
  resolveReportRange,
  startOfCivilDay,
  toIsoDate,
  type CivilDate,
} from "../pay-period";

const d = (year: number, month: number, day: number): CivilDate => ({ year, month, day });
const iso = (c: CivilDate) => toIsoDate(c);
const period = (c: CivilDate) => {
  const p = payPeriodContaining(c);
  return `${p.key} ${iso(p.start)}→${iso(p.end)}`;
};

describe("official pay periods — Period 1 = 21st (previous month) → 5th, Period 2 = 6th → 20th", () => {
  it("the boundary days around every edge land in the right period (January)", () => {
    expect(period(d(2026, 1, 5))).toBe("2026-01-P1 2025-12-21→2026-01-05");
    expect(period(d(2026, 1, 6))).toBe("2026-01-P2 2026-01-06→2026-01-20");
    expect(period(d(2026, 1, 20))).toBe("2026-01-P2 2026-01-06→2026-01-20");
    expect(period(d(2026, 1, 21))).toBe("2026-02-P1 2026-01-21→2026-02-05");
    expect(period(d(2026, 1, 31))).toBe("2026-02-P1 2026-01-21→2026-02-05");
  });

  it("February boundaries", () => {
    expect(period(d(2026, 2, 5))).toBe("2026-02-P1 2026-01-21→2026-02-05");
    expect(period(d(2026, 2, 6))).toBe("2026-02-P2 2026-02-06→2026-02-20");
    expect(period(d(2026, 2, 20))).toBe("2026-02-P2 2026-02-06→2026-02-20");
    expect(period(d(2026, 2, 21))).toBe("2026-03-P1 2026-02-21→2026-03-05");
  });

  it("a normal (28-day) February: the 28th belongs to March's Period 1, which still ends on March 5", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(period(d(2026, 2, 28))).toBe("2026-03-P1 2026-02-21→2026-03-05");
    expect(period(d(2026, 3, 1))).toBe("2026-03-P1 2026-02-21→2026-03-05");
    expect(period(d(2026, 3, 5))).toBe("2026-03-P1 2026-02-21→2026-03-05");
    expect(period(d(2026, 3, 6))).toBe("2026-03-P2 2026-03-06→2026-03-20");
  });

  it("a leap-year February: the 29th is included in March's Period 1 and no day is lost or doubled", () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(period(d(2028, 2, 20))).toBe("2028-02-P2 2028-02-06→2028-02-20");
    expect(period(d(2028, 2, 21))).toBe("2028-03-P1 2028-02-21→2028-03-05");
    expect(period(d(2028, 2, 29))).toBe("2028-03-P1 2028-02-21→2028-03-05");
    expect(period(d(2028, 3, 1))).toBe("2028-03-P1 2028-02-21→2028-03-05");
    const p = payPeriodContaining(d(2028, 2, 29));
    expect(daysBetween(p.start, p.end) + 1).toBe(14); // Feb 21..29 (9) + Mar 1..5 (5)
    const normal = payPeriodContaining(d(2026, 2, 28));
    expect(daysBetween(normal.start, normal.end) + 1).toBe(13); // Feb 21..28 (8) + Mar 1..5 (5)
  });

  it("a 30-day month: the 20th is Period 2, the 21st starts the next Period 1, the 30th is in the next month's Period 1", () => {
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(period(d(2026, 4, 20))).toBe("2026-04-P2 2026-04-06→2026-04-20");
    expect(period(d(2026, 4, 21))).toBe("2026-05-P1 2026-04-21→2026-05-05");
    expect(period(d(2026, 4, 30))).toBe("2026-05-P1 2026-04-21→2026-05-05");
    expect(period(d(2026, 5, 1))).toBe("2026-05-P1 2026-04-21→2026-05-05");
  });

  it("a 31-day month: the 31st is in the next month's Period 1", () => {
    expect(daysInMonth(2026, 10)).toBe(31);
    expect(period(d(2026, 10, 20))).toBe("2026-10-P2 2026-10-06→2026-10-20");
    expect(period(d(2026, 10, 21))).toBe("2026-11-P1 2026-10-21→2026-11-05");
    expect(period(d(2026, 10, 31))).toBe("2026-11-P1 2026-10-21→2026-11-05");
    expect(period(d(2026, 11, 5))).toBe("2026-11-P1 2026-10-21→2026-11-05");
    expect(period(d(2026, 11, 6))).toBe("2026-11-P2 2026-11-06→2026-11-20");
  });

  it("the year boundary: December 21 → January 5 belongs to JANUARY of the next year, and keys never use the wrong year", () => {
    expect(period(d(2026, 12, 20))).toBe("2026-12-P2 2026-12-06→2026-12-20");
    expect(period(d(2026, 12, 21))).toBe("2027-01-P1 2026-12-21→2027-01-05");
    expect(period(d(2026, 12, 31))).toBe("2027-01-P1 2026-12-21→2027-01-05");
    expect(period(d(2027, 1, 1))).toBe("2027-01-P1 2026-12-21→2027-01-05");
    expect(period(d(2027, 1, 5))).toBe("2027-01-P1 2026-12-21→2027-01-05");
    expect(period(d(2027, 1, 6))).toBe("2027-01-P2 2027-01-06→2027-01-20");
    expect(period(d(2027, 1, 20))).toBe("2027-01-P2 2027-01-06→2027-01-20");
    expect(period(d(2027, 1, 21))).toBe("2027-02-P1 2027-01-21→2027-02-05");
    // and the mirror image: early January belongs to a period that STARTED in the previous year
    expect(payPeriodContaining(d(2027, 1, 3)).start.year).toBe(2026);
  });

  it("EVERY day of eight years (incl. leap years) is in exactly one period; periods are contiguous, never overlap, and never leave a gap", () => {
    let day = d(2024, 1, 1);
    const end = d(2031, 12, 31);
    let previous = payPeriodContaining(day);
    const seenKeys = new Map<string, PeriodSpan>();
    type PeriodSpan = { start: string; end: string };
    let checked = 0;
    for (; compareCivil(day, end) <= 0; day = addDays(day, 1)) {
      const p = payPeriodContaining(day);
      // the day is inside its period (inclusive on both ends)
      expect(compareCivil(p.start, day) <= 0 && compareCivil(day, p.end) <= 0, iso(day)).toBe(true);
      // the official start/end days
      if (p.number === 1) {
        expect(p.start.day).toBe(21);
        expect(p.end.day).toBe(5);
      } else {
        expect(p.start.day).toBe(6);
        expect(p.end.day).toBe(20);
        expect(p.start.month).toBe(p.end.month);
      }
      // a key always names one and the same span
      const span = { start: iso(p.start), end: iso(p.end) };
      const existing = seenKeys.get(p.key);
      if (existing) expect(existing).toEqual(span);
      else seenKeys.set(p.key, span);
      // contiguity with the day before
      if (p.key !== previous.key) {
        expect(iso(addDays(previous.end, 1)), `gap/overlap before ${iso(day)}`).toBe(iso(p.start));
        expect(iso(addDays(p.start, -1))).toBe(iso(previous.end));
      }
      // the navigation helpers agree
      expect(nextPayPeriod(p).key).toBe(payPeriodContaining(addDays(p.end, 1)).key);
      expect(previousPayPeriod(p).key).toBe(payPeriodContaining(addDays(p.start, -1)).key);
      expect(payPeriodFromKey(p.key)).toEqual(p);
      previous = p;
      checked++;
    }
    expect(checked).toBe(2922); // 8 years, 2 leap years
    // exactly two periods per pay month, 12 months × 8 years (+ the boundary months at both ends)
    const months = new Set([...seenKeys.keys()].map((k) => k.slice(0, 7)));
    for (const m of months) {
      if (m === "2024-01" || m === "2032-01") continue; // first / last month are cut by the scan window
      expect(seenKeys.has(`${m}-P1`) && seenKeys.has(`${m}-P2`), m).toBe(true);
    }
  });

  it("there is no third period: nothing starts on any day other than the 6th or 21st, and nothing ends on any day other than the 5th or 20th", () => {
    const starts = new Set<number>();
    const ends = new Set<number>();
    for (let day = d(2026, 1, 1); compareCivil(day, d(2027, 12, 31)) <= 0; day = addDays(day, 1)) {
      const p = payPeriodContaining(day);
      starts.add(p.start.day);
      ends.add(p.end.day);
    }
    expect([...starts].sort((a, b) => a - b)).toEqual([6, 21]);
    expect([...ends].sort((a, b) => a - b)).toEqual([5, 20]);
  });

  it("keys round-trip, malformed keys are rejected", () => {
    expect(payPeriodFromKey("2026-11-P1")?.start).toEqual(d(2026, 10, 21));
    expect(payPeriodFromKey("2026-11-P2")?.end).toEqual(d(2026, 11, 20));
    for (const bad of ["2026-13-P1", "2026-00-P1", "2026-11-P3", "2026-11", "x", "", null, undefined, 5]) expect(payPeriodFromKey(bad), String(bad)).toBeNull();
  });

  it("labels", () => {
    expect(payPeriodRangeLabel(payPeriodContaining(d(2026, 10, 25)))).toBe("Oct 21 – Nov 5, 2026");
    expect(payPeriodRangeLabel(payPeriodContaining(d(2026, 11, 10)))).toBe("Nov 6 – Nov 20, 2026");
    expect(payPeriodRangeLabel(payPeriodContaining(d(2026, 12, 25)))).toBe("Dec 21, 2026 – Jan 5, 2027");
    expect(formatCivilRange(d(2026, 1, 1), d(2026, 3, 31))).toBe("Jan 1 – Mar 31, 2026");
  });
});

describe("the active period follows the date automatically (nothing is reset or deleted)", () => {
  it("the 6th starts Period 2 and the 21st starts the next Period 1 — at LOCAL midnight in the business zone, not at UTC midnight", () => {
    // Business zone is America/Los_Angeles (PST, UTC-8, after the first Sunday of November 2026).
    expect(BUSINESS_TIMEZONE).toBe("America/Los_Angeles");
    // Nov 5 23:59:59 Pacific is still Period 1 even though it is already Nov 6 in UTC (07:59:59Z).
    expect(currentPayPeriod(new Date("2026-11-06T07:59:59Z")).key).toBe("2026-11-P1");
    expect(currentPayPeriod(new Date("2026-11-06T08:00:00Z")).key).toBe("2026-11-P2");
    // A UTC server clock at 03:00Z on the 6th is still the evening of the 5th in Los Angeles.
    expect(currentPayPeriod(new Date("2026-11-06T03:00:00Z")).key).toBe("2026-11-P1");
    // Oct 20 23:59:59 PDT (UTC-7) = Oct 21 06:59:59Z is still Period 2; Oct 21 00:00 PDT = 07:00Z begins the next Period 1.
    expect(currentPayPeriod(new Date("2026-10-21T06:59:59Z")).key).toBe("2026-10-P2");
    expect(currentPayPeriod(new Date("2026-10-21T07:00:00Z")).key).toBe("2026-11-P1");
    expect(currentPayPeriod(new Date("2026-10-21T07:00:00Z")).start).toEqual(d(2026, 10, 21));
  });

  it("the same instant gives the same answer whatever the server's own time zone is (no ambient TZ)", () => {
    const instant = new Date("2026-11-06T03:00:00Z");
    const before = process.env.TZ;
    try {
      for (const tz of ["UTC", "Asia/Tokyo", "Pacific/Auckland", "America/New_York"]) {
        process.env.TZ = tz;
        expect(currentPayPeriod(instant).key, tz).toBe("2026-11-P1");
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("the date in the business zone across the year boundary", () => {
    expect(civilDateInZone(new Date("2027-01-01T07:59:59Z"))).toEqual(d(2026, 12, 31));
    expect(civilDateInZone(new Date("2027-01-01T08:00:00Z"))).toEqual(d(2027, 1, 1));
    expect(currentPayPeriod(new Date("2027-01-01T07:59:59Z")).key).toBe("2027-01-P1"); // Dec 31 → January's Period 1
  });
});

describe("daylight-saving: boundaries are exact instants on both sides of a clock change", () => {
  it("start-of-day instants use the offset in force that day", () => {
    // DST begins Sunday 2026-03-08 (02:00 PST → 03:00 PDT): Mar 8 00:00 is still PST (08:00Z), Mar 9 00:00 is PDT (07:00Z).
    expect(startOfCivilDay(d(2026, 3, 8)).toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(startOfCivilDay(d(2026, 3, 9)).toISOString()).toBe("2026-03-09T07:00:00.000Z");
    // DST ends Sunday 2026-11-01 (02:00 PDT → 01:00 PST): Nov 1 00:00 is PDT (07:00Z), Nov 2 00:00 is PST (08:00Z).
    expect(startOfCivilDay(d(2026, 11, 1)).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(startOfCivilDay(d(2026, 11, 2)).toISOString()).toBe("2026-11-02T08:00:00.000Z");
    // Ordinary summer / winter days.
    expect(startOfCivilDay(d(2026, 7, 4)).toISOString()).toBe("2026-07-04T07:00:00.000Z");
    expect(startOfCivilDay(d(2026, 1, 15)).toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });

  it("a period that spans a clock change is 23 or 25 hours longer/shorter in elapsed time but still covers exactly its calendar days", () => {
    const p = payPeriodContaining(d(2026, 10, 25)); // Oct 21 → Nov 5 spans the Nov 1 change (25-hour day)
    const { start, endExclusive } = civilRangeToInstants(p.start, p.end);
    expect(start.toISOString()).toBe("2026-10-21T07:00:00.000Z");
    expect(endExclusive.toISOString()).toBe("2026-11-06T08:00:00.000Z");
    expect((endExclusive.getTime() - start.getTime()) / 3_600_000).toBe(16 * 24 + 1);
    // the very last instant of the 5th is inside, the first instant of the 6th is outside
    expect(new Date(endExclusive.getTime() - 1).getTime() < endExclusive.getTime()).toBe(true);
    expect(civilDateInZone(new Date(endExclusive.getTime() - 1))).toEqual(d(2026, 11, 5));
    expect(civilDateInZone(endExclusive)).toEqual(d(2026, 11, 6));
  });

  it("consecutive periods share an instant: one's exclusive end is the next one's start (no gap, no overlap, in real time)", () => {
    for (let day = d(2026, 1, 1); compareCivil(day, d(2026, 12, 31)) <= 0; day = addDays(day, 7)) {
      const p = payPeriodContaining(day);
      const n = nextPayPeriod(p);
      expect(civilRangeToInstants(p.start, p.end).endExclusive.getTime()).toBe(civilRangeToInstants(n.start, n.end).start.getTime());
    }
  });
});

describe("parseIsoDate", () => {
  it("accepts real calendar dates only", () => {
    expect(parseIsoDate("2026-02-28")).toEqual(d(2026, 2, 28));
    expect(parseIsoDate("2028-02-29")).toEqual(d(2028, 2, 29));
    for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "26-01-01", "2026/01/01", "2026-1-1", "", " ", "2026-01-01T00:00:00Z", null, undefined, 20260101]) {
      expect(parseIsoDate(bad as string), String(bad)).toBeNull();
    }
  });
});

describe("resolveReportRange — one resolver for every report", () => {
  const NOW = new Date("2026-11-10T20:00:00Z"); // Nov 10, 2026 Pacific → Period 2 (Nov 6 – Nov 20)

  it("defaults to the CURRENT pay period and marks it as the active one", () => {
    const r = resolveReportRange({}, NOW);
    expect(r).toMatchObject({ kind: "pay-period", from: d(2026, 11, 6), to: d(2026, 11, 20), isCurrentPayPeriod: true });
    expect(r.label).toBe("Pay Period 2 · Nov 6 – Nov 20, 2026");
    expect(r.warning).toBeUndefined();
  });

  it("previous pay period, this month, last month, year, all", () => {
    expect(resolveReportRange({ period: "previous" }, NOW)).toMatchObject({ kind: "previous-pay-period", from: d(2026, 10, 21), to: d(2026, 11, 5), isCurrentPayPeriod: false });
    expect(resolveReportRange({ period: "previous-pay-period" }, NOW).from).toEqual(d(2026, 10, 21));
    expect(resolveReportRange({ period: "month" }, NOW)).toMatchObject({ from: d(2026, 11, 1), to: d(2026, 11, 30) });
    expect(resolveReportRange({ period: "previous-month" }, NOW)).toMatchObject({ from: d(2026, 10, 1), to: d(2026, 10, 31) });
    expect(resolveReportRange({ period: "year" }, NOW)).toMatchObject({ from: d(2026, 1, 1), to: d(2026, 12, 31) });
    const all = resolveReportRange({ period: "all" }, NOW);
    expect(all.from).toBeUndefined();
    expect(all.to).toBeUndefined();
  });

  it("legacy Salesboard links (today / week) still resolve, in the business zone", () => {
    expect(resolveReportRange({ period: "today" }, NOW)).toMatchObject({ from: d(2026, 11, 10), to: d(2026, 11, 10) });
    const week = resolveReportRange({ period: "week" }, NOW); // Tuesday → Sunday Nov 8 .. Saturday Nov 14
    expect(week.from).toEqual(d(2026, 11, 8));
    expect(week.to).toEqual(d(2026, 11, 14));
  });

  it("explicit From/To wins over any quick selector and is a CUSTOM range (never mistaken for the current period)", () => {
    const r = resolveReportRange({ period: "month", from: "2026-10-21", to: "2026-11-05" }, NOW);
    expect(r).toMatchObject({ kind: "custom", from: d(2026, 10, 21), to: d(2026, 11, 5), isCurrentPayPeriod: false });
    expect(r.payPeriod?.key).toBe("2026-11-P1"); // it happens to be exactly the previous pay period
    const jan = resolveReportRange({ from: "2026-01-01", to: "2026-03-31" }, NOW);
    expect(jan).toMatchObject({ kind: "custom", isCurrentPayPeriod: false });
    expect(jan.payPeriod).toBeUndefined();
  });

  it("a custom range that is exactly the active pay period is still flagged as the active period", () => {
    expect(resolveReportRange({ from: "2026-11-06", to: "2026-11-20" }, NOW).isCurrentPayPeriod).toBe(true);
  });

  it("bad, reversed or half-filled dates fall back to the current pay period with a warning — they never throw and never widen the range", () => {
    for (const input of [{ from: "2026-11-10" }, { to: "2026-11-10" }, { from: "nope", to: "2026-11-10" }, { from: "2026-02-30", to: "2026-03-01" }, { from: "2026-11-20", to: "2026-11-06" }]) {
      const r = resolveReportRange(input, NOW);
      expect(r, JSON.stringify(input)).toMatchObject({ kind: "pay-period", from: d(2026, 11, 6), to: d(2026, 11, 20), isCurrentPayPeriod: true });
      expect(r.warning).toBeTruthy();
    }
    expect(resolveReportRange({ period: "<script>" }, NOW).kind).toBe("pay-period");
    expect(resolveReportRange({ period: "custom" }, NOW).warning).toBeTruthy();
  });

  it("the 6th and the 21st flip the default on their own — no reset, no input", () => {
    const keyAt = (iso: string) => resolveReportRange({}, new Date(iso)).payPeriod!.key;
    expect(keyAt("2026-11-05T20:00:00Z")).toBe("2026-11-P1");
    expect(keyAt("2026-11-06T20:00:00Z")).toBe("2026-11-P2");
    expect(keyAt("2026-11-20T20:00:00Z")).toBe("2026-11-P2");
    expect(keyAt("2026-11-21T20:00:00Z")).toBe("2026-12-P1");
  });
});

describe("previousEquivalentRange (for 'vs previous' comparisons)", () => {
  const NOW = new Date("2026-11-10T20:00:00Z");
  it("a pay period compares with the previous pay period — across the year boundary too", () => {
    const prev = previousEquivalentRange(resolveReportRange({}, NOW))!;
    expect(prev).toMatchObject({ from: d(2026, 10, 21), to: d(2026, 11, 5) });
    const jan = previousEquivalentRange(resolveReportRange({}, new Date("2027-01-03T20:00:00Z")))!;
    expect(jan).toMatchObject({ from: d(2026, 12, 6), to: d(2026, 12, 20) });
  });

  it("a calendar month compares with the previous month", () => {
    expect(previousEquivalentRange(resolveReportRange({ period: "month" }, NOW))).toMatchObject({ from: d(2026, 10, 1), to: d(2026, 10, 31) });
    expect(previousEquivalentRange(resolveReportRange({ period: "month" }, new Date("2027-01-15T20:00:00Z")))).toMatchObject({ from: d(2026, 12, 1), to: d(2026, 12, 31) });
  });

  it("any other range compares with the same number of days directly before it", () => {
    const prev = previousEquivalentRange(resolveReportRange({ from: "2026-11-02", to: "2026-11-08" }, NOW))!;
    expect(prev).toMatchObject({ from: d(2026, 10, 26), to: d(2026, 11, 1) });
    expect(daysBetween(prev.from, prev.to) + 1).toBe(7);
  });

  it("'all time' has nothing to compare with", () => {
    expect(previousEquivalentRange(resolveReportRange({ period: "all" }, NOW))).toBeNull();
  });
});

describe("percentChange", () => {
  it("is null — never Infinity or NaN — when the previous value is zero or unusable", () => {
    expect(percentChange(100, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(NaN, 5)).toBeNull();
    expect(percentChange(5, Infinity)).toBeNull();
  });
  it("computes up, down and flat", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(100, 100)).toBe(0);
    expect(percentChange(0, 100)).toBe(-100);
  });
});

describe("one business time zone for the whole CRM", () => {
  it("the Pacific clock, the lead-capture time display and the pay-period boundaries all use the same zone", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const file of ["src/components/layout/pacific-clock.tsx", "src/components/leads/lead-captured-event.tsx"]) {
      expect(fs.readFileSync(path.join(process.cwd(), file), "utf8"), file).toContain(BUSINESS_TIMEZONE);
    }
  });
});
