// Calendar days in the CRM's business time zone (the same fixed zone as the header clock, lead times and pay periods: lib/pay-period.ts BUSINESS_TIMEZONE).
// Used for (a) grouping the failed sign-in log by day and (b) the daily customer-email reveal allowance, whose "day" must never depend on a browser clock.
// DST-safe: every conversion goes through Intl for the instant in question, never a fixed UTC offset.
import { BUSINESS_TIMEZONE } from "@/lib/pay-period";

const keyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** The business-zone calendar day of an instant, as yyyy-MM-dd. */
export function businessDayKey(date: Date): string {
  return keyFormat.format(date); // en-CA renders yyyy-MM-dd
}

function offsetMinutesAt(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** The instant (UTC) at which the given business day starts, and the instant the next one starts: a 23-, 24- or 25-hour span on DST days. */
export function businessDayRange(dayKey: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) throw new Error("Invalid day key");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const startOf = (yy: number, mm: number, dd: number) => {
    const guess = Date.UTC(yy, mm - 1, dd);
    let start = guess - offsetMinutesAt(guess) * 60_000;
    // one correction pass for days whose midnight falls on the other side of a DST change
    start = guess - offsetMinutesAt(start) * 60_000;
    return start;
  };
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return { start: new Date(startOf(y, mo, d)), end: new Date(startOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate())) };
}

// ───────────── the customer-email reveal period (resets at 1:15 PM America/Los_Angeles, every day) ─────────────
// The allowance of five reveals, and the right to keep SEEING a revealed address, both belong to a "reveal period" that starts at 13:15 wall-clock time in the business zone
// and ends at 13:15 the next day. The boundary is a wall-clock time in the IANA zone, never a fixed UTC offset, so it follows daylight saving (13:15 PST = 21:15 UTC, 13:15 PDT =
// 20:15 UTC) and a period is 23, 24 or 25 hours long across a change. Used by the server (the only authority) and, for the same arithmetic, by the browser watcher that re-masks a
// stale tab. 13:15 is never inside a daylight-saving gap (the changes happen at 02:00), so the conversion below is exact.
export const REVEAL_RESET_HOUR = 13;
export const REVEAL_RESET_MINUTE = 15;
/** The label shown to people. */
export const REVEAL_RESET_LABEL = "1:15 PM Pacific time";

const wallFormat = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIMEZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function wallParts(date: Date) {
  const parts = wallFormat.formatToParts(date);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute") };
}

/** The instant at which the business-zone wall clock shows the given date and time (valid for times that are not inside a daylight-saving gap). */
function zonedWallToInstant(y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - offsetMinutesAt(guess) * 60_000;
  t = guess - offsetMinutesAt(t) * 60_000; // one correction pass, as in businessDayRange
  return new Date(t);
}

export type RevealPeriod = {
  /** Stored in the reveal tables' dayKey column (VarChar(10)): "p" + the business-zone date on which the period STARTED, e.g. "p20261122". It can never equal an older yyyy-MM-dd key. */
  key: string;
  startsAt: Date;
  /** The next 13:15 in the business zone: when the allowance refills and every revealed address becomes masked again. */
  endsAt: Date;
};

/** The reveal period that contains the instant `now`. */
export function emailRevealPeriod(now: Date): RevealPeriod {
  const w = wallParts(now);
  const beforeReset = w.hour < REVEAL_RESET_HOUR || (w.hour === REVEAL_RESET_HOUR && w.minute < REVEAL_RESET_MINUTE);
  const start = new Date(Date.UTC(w.year, w.month - 1, w.day - (beforeReset ? 1 : 0)));
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1));
  const y = start.getUTCFullYear();
  const mo = start.getUTCMonth() + 1;
  const d = start.getUTCDate();
  return {
    key: `p${y}${String(mo).padStart(2, "0")}${String(d).padStart(2, "0")}`,
    startsAt: zonedWallToInstant(y, mo, d, REVEAL_RESET_HOUR, REVEAL_RESET_MINUTE),
    endsAt: zonedWallToInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), REVEAL_RESET_HOUR, REVEAL_RESET_MINUTE),
  };
}

const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIMEZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dayLabelFormat = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIMEZONE, year: "numeric", month: "long", day: "numeric" });

/** "09:15:12" in the business zone. */
export function formatBusinessTime(date: Date): string {
  return timeFormat.format(date);
}
/** "November 20, 2026" for a day key (not an instant: no zone shift can move it). */
export function formatDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return dayLabelFormat.format(new Date(Date.UTC(y, m - 1, d, 12)));
}
