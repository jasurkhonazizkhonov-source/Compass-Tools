// Shared utilities for GDS itinerary text parsing (Sabre/SWAN, Apollo).
// Parsers are defensive: when a field can't be confidently determined, it is
// left undefined and reported in `warnings` rather than guessed.

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** Fields a parsed segment can flag as low-confidence / needing manual review. */
export type ParsedFieldKey =
  | "airline"
  | "flightNumber"
  | "bookingClass"
  | "cabin"
  | "departureAirport"
  | "arrivalAirport"
  | "departureDate"
  | "departureTime"
  | "arrivalDate"
  | "arrivalTime";

/** A parser warning tagged with the single field it concerns. Every warning
 * this parser produces is tied to exactly one field (there are no general/
 * untagged warnings) — the tag lets the UI clear a warning the instant the
 * agent corrects that specific field, instead of the warning persisting as
 * stale text after the underlying issue is already fixed. */
export type ParsedWarning = { field: ParsedFieldKey; message: string };

export type ParsedSegment = {
  sequence: number;
  airlineCode?: string;
  flightNumber?: string;
  bookingClass?: string;
  /** Best-effort cabin guess derived from the booking class letter — always
   * paired with a `cabin` entry in `uncertainFields`, since RBD-to-cabin
   * mapping is airline-specific and this is a generic heuristic, never an
   * authoritative source. */
  cabinGuess?: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  departureAirport?: string;
  arrivalAirport?: string;
  departureDate?: string; // ISO yyyy-MM-dd
  /** True when departureDate came from a token with an explicit embedded
   * 2-digit year (e.g. "25SEP27"), rather than being resolved against the
   * caller-supplied referenceYear. Callers must never second-guess or
   * roll forward a date the source itinerary was already explicit about —
   * see parseGdsItinerary's today-relative rollover. */
  hasExplicitYear?: boolean;
  departureTime?: string; // HH:mm 24h
  arrivalDate?: string;
  arrivalTime?: string;
  dayOfWeek?: string;
  /** A compound day-of-week pair like "TH/FR" (departure/arrival) — kept
   * alongside the single-code `dayOfWeek` above, which single-code lines
   * ("... 725P * FR E") still populate on its own. */
  dayOfWeekPair?: { dep: string; arr: string };
  aircraft?: string;
  /** Free-text operating-carrier name from a standalone "OPERATED BY X"
   * continuation line following this segment's own line (e.g. codeshare
   * flights: "PR2849Z ... " then "OPERATED BY PAL EXPRESS" on the next
   * line) — attached to this segment by parseGdsItinerary's line loop, not
   * parseGdsLine itself, since it isn't part of the segment's own line.
   * `airlineCode`/`flightNumber` above always remain the MARKETING
   * carrier — this field never overwrites them. */
  operatingCarrierName?: string;
  durationMinutes?: number;
  raw: string;
  warnings: ParsedWarning[];
  /** Fields present but not confidently determined — the UI highlights
   * these individually for manual confirmation rather than only showing a
   * single generic banner. */
  uncertainFields: ParsedFieldKey[];
};

// Generic RBD (booking class letter) → cabin heuristic. This varies by
// airline in reality — every mapping produced from it is marked uncertain
// and must be confirmed by the agent, never applied silently.
const BOOKING_CLASS_CABIN_GUESS: Record<string, ParsedSegment["cabinGuess"]> = {
  F: "FIRST", A: "FIRST", P: "FIRST", R: "FIRST",
  J: "BUSINESS", C: "BUSINESS", D: "BUSINESS", I: "BUSINESS", Z: "BUSINESS",
  W: "PREMIUM_ECONOMY", E: "PREMIUM_ECONOMY", PE: "PREMIUM_ECONOMY",
  Y: "ECONOMY", B: "ECONOMY", M: "ECONOMY", H: "ECONOMY", Q: "ECONOMY",
  K: "ECONOMY", L: "ECONOMY", U: "ECONOMY", T: "ECONOMY", X: "ECONOMY",
  V: "ECONOMY", N: "ECONOMY", O: "ECONOMY", G: "ECONOMY", S: "ECONOMY",
};

export function guessCabinFromBookingClass(bookingClass: string | undefined): ParsedSegment["cabinGuess"] {
  if (!bookingClass) return undefined;
  return BOOKING_CLASS_CABIN_GUESS[bookingClass.toUpperCase()];
}

/**
 * Parses a GDS date token like "25SEP" into an ISO date using the given
 * year verbatim — GDS output omits the year, so the caller supplies it.
 * Cross-year itineraries (e.g. a segment in December followed by one in
 * January) are resolved by `parseGdsItinerary`'s date-ordering pass, not
 * here, so this stays a pure, deterministic conversion.
 */
export function parseGdsDate(token: string, year: number): string | undefined {
  // A trailing 2-digit year (e.g. "25SEP26") is explicit ground truth and
  // overrides the passed-in reference year — some agencies include it for
  // itineraries that span a year boundary or are booked far in advance.
  const match = /^(\d{1,2})([A-Z]{3})(\d{2})?$/i.exec(token.trim());
  if (!match) return undefined;
  const day = Number(match[1]);
  const monthKey = match[2].toUpperCase();
  const month = MONTHS[monthKey];
  const effectiveYear = match[3] ? 2000 + Number(match[3]) : year;
  if (month === undefined || day < 1 || day > 31) return undefined;

  const iso = new Date(Date.UTC(effectiveYear, month, day));
  if (iso.getUTCMonth() !== month || iso.getUTCDate() !== day) return undefined; // e.g. 31FEB
  return iso.toISOString().slice(0, 10);
}

export type ParsedGdsTime = {
  time: string;
  /** Explicit day-offset GDS output appends directly after an arrival time
   * for long/overnight flights: a signed or unsigned digit ("725P1" /
   * "725P+1" = next day, "800A+2" = two days later, "1100P-1" = the day
   * BEFORE departure), or a bare sign with no digit ("1225P+" / "1200AM-"),
   * which always means exactly one day forward/back — this is the
   * authoritative source when present, since relying on "arrival clock time
   * < departure clock time" alone breaks for very long flights where
   * arrival time is still later in the day despite spanning a day (or more)
   * boundary. An unsigned digit ("725P1") is always a positive (next-day)
   * offset in GDS shorthand. */
  dayOffset: number;
};

/** Parses a GDS time token like "600P", "1830", "0600A", "6:30P", or with an
 * explicit trailing day-offset like "725P1", "725P+1", "1100P-1", or a bare
 * "1225P+"/"1200AM-" (sign with no digit, meaning exactly ±1 day) into 24h
 * "HH:mm" (+ that offset, if present). */
export function parseGdsTime(token: string): ParsedGdsTime | undefined {
  // A messy copy-paste sometimes glues the e-ticket "*" flag directly onto
  // the offset sign with no space ("1225P+*") — strip a trailing "*" before
  // parsing; it carries no time/offset information of its own (see the
  // bare "*" token handling in gds-line.ts).
  const normalized = token.trim().replace(":", "").replace(/\*$/, "");
  // The A/P suffix (and this M?) is optional — a bare 24h time like "1830"
  // is also valid GDS shorthand. The trailing "M?" tolerates a full
  // "AM"/"PM" suffix in addition to the strict single-letter GDS form
  // ("A"/"P") — some pasted itineraries use the human-readable form.
  const match = /^(\d{3,4})(?:([AP])M?)?([+-])?(\d)?$/i.exec(normalized);
  if (!match) return undefined;
  const digits = match[1].padStart(4, "0");
  let hour = Number(digits.slice(0, 2));
  const minute = Number(digits.slice(2, 4));
  if (minute > 59) return undefined;
  const suffix = match[2]?.toUpperCase();

  if (suffix === "A") {
    if (hour === 12) hour = 0;
  } else if (suffix === "P") {
    if (hour !== 12) hour += 12;
  }
  if (hour > 23) return undefined;

  const sign = match[3];
  const digit = match[4];
  let dayOffset: number;
  if (sign) {
    const magnitude = digit ? Number(digit) : 1;
    dayOffset = sign === "-" ? -magnitude : magnitude;
  } else {
    dayOffset = digit ? Number(digit) : 0;
  }

  return { time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, dayOffset };
}

/** Adds `days` to an ISO yyyy-MM-dd date string. */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function minutesBetween(depDateIso: string, depTime: string, arrDateIso: string, arrTime: string): number {
  const dep = new Date(`${depDateIso}T${depTime}:00Z`).getTime();
  const arr = new Date(`${arrDateIso}T${arrTime}:00Z`).getTime();
  return Math.round((arr - dep) / 60000);
}

export function formatDuration(minutes: number): string {
  if (minutes < 0 || Number.isNaN(minutes)) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

/**
 * Resolves arrival date given dep date/time, arr time, and any explicit
 * day-offset signal already resolved by the caller (a fused +/digit marker
 * on the arrival time, a standalone +N/-N token, or a departure/arrival
 * day-of-week pair — see gds-line.ts's priority chain). An explicit offset
 * is always authoritative.
 *
 * When NO explicit signal is present, the arrival date stays on the SAME
 * calendar day as departure — never inferred from comparing the raw local
 * clock-time strings. Real GDS/Apollo output always marks a genuine
 * calendar-day change explicitly (the +/digit suffix convention exists
 * specifically so agents/parsers never have to guess); relying instead on
 * "arrival clock reads earlier than departure clock" is unreliable and
 * actively wrong for a route with a large timezone delta or an
 * international-date-line crossing, where the LOCAL arrival clock can
 * legitimately read earlier than the local departure clock on the exact
 * same GDS-recorded date (e.g. a westbound MNL->YVR flight departing 09:25
 * and landing 06:25 the same day — no day actually passed, the ~15h zone
 * difference alone accounts for the smaller clock reading). Previously this
 * function added a day in that case, which was the reported bug: it
 * conflated "the arrival clock number is smaller" with "a calendar day
 * passed," the same naive-local-time-comparison error already diagnosed and
 * fixed one layer downstream for duration math (see flight-duration.ts's
 * own header comment on the DFW->ATH case) but never corrected here, one
 * layer upstream, at date resolution itself.
 */
export function resolveArrivalDate(depDateIso: string, depTime: string, arrTime: string, explicitDayOffset = 0): string {
  if (explicitDayOffset !== 0) return addDaysIso(depDateIso, explicitDayOffset);
  return depDateIso;
}

// Monday-first index so a plain forward difference is always non-negative —
// matches the ISO weekday convention used by getWeekdayCode below.
const WEEKDAY_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/**
 * Infers a calendar-day offset from a GDS day-of-week pair like "TH/FR" or
 * "TH/WE" alone, with no explicit numeric/sign marker available. Day codes
 * are inherently cyclic (mod 7), so there are always two representative
 * offsets consistent with a given pair (e.g. TH->WE is either +6 or -1) —
 * this picks whichever has the smaller absolute value, i.e. "assume the
 * itinerary spans the fewest calendar days consistent with the given pair."
 * That single rule reproduces both real-world cases GDS output uses this
 * shorthand for: a normal forward overnight (TH/FR -> +1) and a westbound
 * date-line crossing where local arrival date is earlier than local
 * departure date despite real elapsed time moving forward (TH/WE -> -1).
 * Returns undefined for unrecognized codes rather than guessing.
 */
export function resolveDayPairOffset(depDow: string, arrDow: string): number | undefined {
  const depIdx = WEEKDAY_ORDER.indexOf(depDow.toUpperCase());
  const arrIdx = WEEKDAY_ORDER.indexOf(arrDow.toUpperCase());
  if (depIdx === -1 || arrIdx === -1) return undefined;
  if (depIdx === arrIdx) return 0;
  const forward = (arrIdx - depIdx + 7) % 7; // 1..6
  const backward = forward - 7; // -6..-1
  return Math.abs(forward) <= Math.abs(backward) ? forward : backward;
}

/** The GDS 2-letter weekday code ("MO".."SU") for an ISO yyyy-MM-dd date,
 * for cross-validating a parsed day-of-week token against the date the
 * parser actually computed (see §14 validation) — computed from the date
 * itself, never trusted from the GDS text. */
export function getWeekdayCode(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  // getUTCDay(): 0=Sun..6=Sat -> rotate to Monday-first to index WEEKDAY_ORDER.
  const isoWeekday = (d.getUTCDay() + 6) % 7;
  return WEEKDAY_ORDER[isoWeekday];
}
