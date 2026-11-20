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
