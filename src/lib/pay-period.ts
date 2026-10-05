// The agency's OFFICIAL pay periods and the calendar arithmetic behind every date-range report (Salesboard, Commissions).
//
// Exactly two pay periods per calendar month, covering EVERY day (no gap, no third period):
//   Period 1  = the 21st of the previous month  →  the 5th of the current month   (inclusive)
//   Period 2  = the 6th                          →  the 20th of the current month  (inclusive)
// So days 1–5 belong to that month's Period 1, 6–20 to its Period 2, and 21–end-of-month to the NEXT month's Period 1.
//
// Nothing here is stored or "reset": the active period is derived from today's date, and a past period is just a date range, so
// every historical sale and commission stays exactly where it was. A period is identified by a deterministic key such as
// "2026-11-P1" (the month in the key is the month the period ENDS in, i.e. the pay month).
//
// Boundaries are CALENDAR days in the business time zone — never UTC days. The zone is the one the CRM already uses for its
// Pacific clock and lead-capture times (America/Los_Angeles); a server running in UTC must not move a period boundary by 7–8
// hours. Civil dates are the unit; an instant is produced only at the very edge (midnight of a civil day in that zone), by a
// DST-aware conversion, so a boundary is exact on both sides of a daylight-saving change.

export const BUSINESS_TIMEZONE = "America/Los_Angeles";

/** A calendar day (no time, no zone). `month` is 1–12. */
export type CivilDate = { year: number; month: number; day: number };

export type PayPeriod = {
  /** Deterministic identifier, e.g. "2026-11-P1" (pay month = the month the period ends in). */
  key: string;
  number: 1 | 2;
  start: CivilDate;
  /** Inclusive. */
  end: CivilDate;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

// ---------------------------------------------------------------------------------------------------------------------------
// civil-date arithmetic (pure; uses UTC internally only as a calendar calculator)
// ---------------------------------------------------------------------------------------------------------------------------
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidCivilDate(c: CivilDate): boolean {
  return Number.isInteger(c.year) && Number.isInteger(c.month) && Number.isInteger(c.day) && c.year >= 1900 && c.year <= 2200 && c.month >= 1 && c.month <= 12 && c.day >= 1 && c.day <= daysInMonth(c.year, c.month);
}

export function addDays(c: CivilDate, days: number): CivilDate {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function addMonths(c: { year: number; month: number }, months: number): { year: number; month: number } {
  const idx = c.year * 12 + (c.month - 1) + months;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export const sameCivil = (a: CivilDate, b: CivilDate) => compareCivil(a, b) === 0;

export function daysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function toIsoDate(c: CivilDate): string {
  return `${String(c.year).padStart(4, "0")}-${pad2(c.month)}-${pad2(c.day)}`;
}

/** Strict "YYYY-MM-DD" → civil date; null for anything else (including 2026-02-30). */
export function parseIsoDate(value: unknown): CivilDate | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const c = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return isValidCivilDate(c) ? c : null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// instant <-> civil date in the business zone
// ---------------------------------------------------------------------------------------------------------------------------
const formatters = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f;
}

function zonedParts(instant: Date, timeZone: string) {
  const parts = zoneFormatter(timeZone).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour") % 24, minute: n("minute"), second: n("second") };
}

/** The calendar date it is, right now, in the business zone. */
export function civilDateInZone(instant: Date, timeZone: string = BUSINESS_TIMEZONE): CivilDate {
  const p = zonedParts(instant, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

/** Offset of the zone from UTC at an instant, in ms (negative west of Greenwich). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The exact instant at which a civil day BEGINS (00:00) in the business zone — correct across daylight-saving changes. */
export function startOfCivilDay(c: CivilDate, timeZone: string = BUSINESS_TIMEZONE): Date {
  const guess = Date.UTC(c.year, c.month - 1, c.day, 0, 0, 0);
  let t = guess - zoneOffsetMs(new Date(guess), timeZone);
  const corrected = guess - zoneOffsetMs(new Date(t), timeZone);
  if (corrected !== t) t = corrected;
  return new Date(t);
}

/** [start, endExclusive) instants for an inclusive civil-day range. */
export function civilRangeToInstants(from: CivilDate, to: CivilDate, timeZone: string = BUSINESS_TIMEZONE): { start: Date; endExclusive: Date } {
  return { start: startOfCivilDay(from, timeZone), endExclusive: startOfCivilDay(addDays(to, 1), timeZone) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// the pay-period model
// ---------------------------------------------------------------------------------------------------------------------------
export function payPeriodKey(payYear: number, payMonth: number, number: 1 | 2) {
  return `${String(payYear).padStart(4, "0")}-${pad2(payMonth)}-P${number}`;
}

/** The official pay period a calendar day belongs to. Every day belongs to exactly one. */
export function payPeriodContaining(c: CivilDate): PayPeriod {
  if (c.day <= 5) {
    const prev = addMonths(c, -1);
    return { key: payPeriodKey(c.year, c.month, 1), number: 1, start: { year: prev.year, month: prev.month, day: 21 }, end: { year: c.year, month: c.month, day: 5 } };
  }
  if (c.day <= 20) {
    return { key: payPeriodKey(c.year, c.month, 2), number: 2, start: { year: c.year, month: c.month, day: 6 }, end: { year: c.year, month: c.month, day: 20 } };
  }
  // 21st → end of month: the NEXT month's Period 1.
  const next = addMonths(c, 1);
  return { key: payPeriodKey(next.year, next.month, 1), number: 1, start: { year: c.year, month: c.month, day: 21 }, end: { year: next.year, month: next.month, day: 5 } };
}

export const currentPayPeriod = (now: Date = new Date(), timeZone: string = BUSINESS_TIMEZONE) => payPeriodContaining(civilDateInZone(now, timeZone));
export const previousPayPeriod = (p: PayPeriod): PayPeriod => payPeriodContaining(addDays(p.start, -1));
export const nextPayPeriod = (p: PayPeriod): PayPeriod => payPeriodContaining(addDays(p.end, 1));

/** "2026-11-P1" → the period; null if malformed. */
export function payPeriodFromKey(key: unknown): PayPeriod | null {
  if (typeof key !== "string") return null;
  const m = /^(\d{4})-(\d{2})-P([12])$/.exec(key.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || year < 1900 || year > 2200) return null;
  return payPeriodContaining({ year, month, day: m[3] === "1" ? 1 : 10 });
}

// ---------------------------------------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------------------------------------
export function formatCivilShort(c: CivilDate, withYear = false) {
  return `${MONTHS[c.month - 1]} ${c.day}${withYear ? `, ${c.year}` : ""}`;
}

/** "Oct 21 – Nov 5, 2026"  /  "Dec 21, 2026 – Jan 5, 2027"  /  "Nov 6 – Nov 20, 2026". */
export function formatCivilRange(from: CivilDate, to: CivilDate) {
  if (from.year === to.year) return `${formatCivilShort(from)} – ${formatCivilShort(to, true)}`;
  return `${formatCivilShort(from, true)} – ${formatCivilShort(to, true)}`;
}

export const payPeriodRangeLabel = (p: PayPeriod) => formatCivilRange(p.start, p.end);
export const payPeriodName = (p: PayPeriod) => `Pay Period ${p.number}`;

// ---------------------------------------------------------------------------------------------------------------------------
// the report range every date-aware report uses (ONE resolver, so Salesboard and Commissions can never disagree)
// ---------------------------------------------------------------------------------------------------------------------------
export type ReportPeriodKind = "pay-period" | "previous-pay-period" | "month" | "previous-month" | "year" | "today" | "week" | "all" | "custom";

export const REPORT_PERIOD_KINDS: readonly ReportPeriodKind[] = ["pay-period", "previous-pay-period", "month", "previous-month", "year", "today", "week", "all", "custom"];

/** Old Salesboard links used ?period=today|week|month|year|all; "pay"/"previous" are the new short forms. */
const KIND_ALIASES: Record<string, ReportPeriodKind> = {
  pay: "pay-period",
  "pay-period": "pay-period",
  previous: "previous-pay-period",
  "previous-pay-period": "previous-pay-period",
  month: "month",
  "previous-month": "previous-month",
  year: "year",
  today: "today",
  week: "week",
  all: "all",
  custom: "custom",
};

export type ResolvedReportRange = {
  kind: ReportPeriodKind;
  /** Inclusive civil days; undefined for "all" (no bound). */
  from?: CivilDate;
  to?: CivilDate;
  /** Set when the range is exactly one official pay period. */
  payPeriod?: PayPeriod;
  /** True only for the ACTIVE pay period — the one whose commission is "the current commission". */
  isCurrentPayPeriod: boolean;
  label: string;
  /** Why the requested range was not used (bad / reversed / incomplete dates); the default range is returned instead. */
  warning?: string;
};

export type ReportRangeInput = {
  period?: string | null;
  from?: string | null;
  to?: string | null;
  /** A specific official pay period by key ("2026-11-P1") — for jumping to any past period. */
  payPeriod?: string | null;
};

function monthRange(year: number, month: number) {
  return { from: { year, month, day: 1 }, to: { year, month, day: daysInMonth(year, month) } };
}

/**
 * Resolves the user's selection (a quick selector or an explicit From/To) into one inclusive civil-day range.
 * Explicit From+To always wins. Invalid input never throws and never widens access: it falls back to the CURRENT pay
 * period with a `warning`. Date filters narrow a report — they are never an authorization filter.
 */
export function resolveReportRange(input: ReportRangeInput, now: Date = new Date(), timeZone: string = BUSINESS_TIMEZONE): ResolvedReportRange {
  const today = civilDateInZone(now, timeZone);
  const current = payPeriodContaining(today);

  const fallback = (warning?: string): ResolvedReportRange => ({
    kind: "pay-period",
    from: current.start,
    to: current.end,
    payPeriod: current,
    isCurrentPayPeriod: true,
    label: `${payPeriodName(current)} · ${payPeriodRangeLabel(current)}`,
    warning,
  });

  const rawFrom = input.from?.trim() || "";
  const rawTo = input.to?.trim() || "";
  if (rawFrom || rawTo) {
    const from = parseIsoDate(rawFrom);
    const to = parseIsoDate(rawTo);
    if (!from || !to) return fallback("Choose both a valid From and To date.");
    if (compareCivil(from, to) > 0) return fallback("The From date must be on or before the To date.");
    const asPeriod = [current, previousPayPeriod(current)].find((p) => sameCivil(p.start, from) && sameCivil(p.end, to));
    return {
      kind: "custom",
      from,
      to,
      payPeriod: asPeriod,
      isCurrentPayPeriod: !!asPeriod && asPeriod.key === current.key,
      label: formatCivilRange(from, to),
    };
  }

  if (input.payPeriod?.trim()) {
    const chosen = payPeriodFromKey(input.payPeriod);
    if (!chosen) return fallback("That pay period was not recognised.");
    return {
      kind: "pay-period",
      from: chosen.start,
      to: chosen.end,
      payPeriod: chosen,
      isCurrentPayPeriod: chosen.key === current.key,
      label: `${payPeriodName(chosen)} · ${payPeriodRangeLabel(chosen)}`,
    };
  }

  const kind = KIND_ALIASES[(input.period ?? "").trim().toLowerCase()];
  switch (kind) {
    case undefined:
    case "pay-period":
      return fallback();
    case "previous-pay-period": {
      const prev = previousPayPeriod(current);
      return { kind, from: prev.start, to: prev.end, payPeriod: prev, isCurrentPayPeriod: false, label: `Previous ${payPeriodName(prev)} · ${payPeriodRangeLabel(prev)}` };
    }
    case "month": {
      const r = monthRange(today.year, today.month);
      return { kind, ...r, isCurrentPayPeriod: false, label: formatCivilRange(r.from, r.to) };
    }
    case "previous-month": {
      const pm = addMonths(today, -1);
      const r = monthRange(pm.year, pm.month);
      return { kind, ...r, isCurrentPayPeriod: false, label: formatCivilRange(r.from, r.to) };
    }
    case "year":
      return { kind, from: { year: today.year, month: 1, day: 1 }, to: { year: today.year, month: 12, day: 31 }, isCurrentPayPeriod: false, label: formatCivilRange({ year: today.year, month: 1, day: 1 }, { year: today.year, month: 12, day: 31 }) };
    case "today":
      return { kind, from: today, to: today, isCurrentPayPeriod: false, label: formatCivilShort(today, true) };
    case "week": {
      const sunday = addDays(today, -new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay());
      return { kind, from: sunday, to: addDays(sunday, 6), isCurrentPayPeriod: false, label: formatCivilRange(sunday, addDays(sunday, 6)) };
    }
    case "all":
      return { kind, isCurrentPayPeriod: false, label: "All time" };
    case "custom":
      return fallback("Choose both a valid From and To date.");
  }
}

/**
 * The equivalent range immediately BEFORE a resolved one, for "vs previous" comparisons. A pay period compares with the
 * previous pay period, a calendar month with the previous month, anything else with the same number of days directly before it.
 * "All time" has no previous range.
 */
export function previousEquivalentRange(r: ResolvedReportRange): { from: CivilDate; to: CivilDate; label: string } | null {
  if (!r.from || !r.to) return null;
  if (r.payPeriod && sameCivil(r.payPeriod.start, r.from) && sameCivil(r.payPeriod.end, r.to)) {
    const prev = previousPayPeriod(r.payPeriod);
    return { from: prev.start, to: prev.end, label: `${payPeriodName(prev)} · ${payPeriodRangeLabel(prev)}` };
  }
  if (r.from.day === 1 && r.from.year === r.to.year && r.from.month === r.to.month && r.to.day === daysInMonth(r.to.year, r.to.month)) {
    const pm = addMonths(r.from, -1);
    const m = monthRange(pm.year, pm.month);
    return { ...m, label: `${MONTHS[pm.month - 1]} ${pm.year}` };
  }
  const length = daysBetween(r.from, r.to) + 1;
  const to = addDays(r.from, -1);
  const from = addDays(to, -(length - 1));
  return { from, to, label: formatCivilRange(from, to) };
}

/** Percentage change vs a previous value; null when the previous value is zero/empty (never Infinity / NaN). */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** The current pay period and the `count - 1` before it, newest first — for a "jump to a past period" list. */
export function recentPayPeriods(current: PayPeriod, count = 12): PayPeriod[] {
  const out = [current];
  while (out.length < count) out.push(previousPayPeriod(out[out.length - 1]));
  return out;
}

/** /path?a=1&b=2 from the defined entries only — used to keep unrelated filters (e.g. the Admin's user filter) while the range changes. */
export function buildReportHref(basePath: string, params: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const text = qs.toString();
  return text ? `${basePath}?${text}` : basePath;
}
