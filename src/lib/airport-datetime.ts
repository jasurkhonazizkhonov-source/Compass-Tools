// ═══════════════════════════════════════════════════════════════════════
// Airport-local date/time storage & display — single source of truth for
// how FlightSegment.departureAt/arrivalAt are constructed AND read back.
//
// A flight's departure/arrival time is a WALL-CLOCK reading at that
// specific airport (e.g. "2:09 PM" at MCO) — it does not correspond to any
// single real-world UTC instant that this application tracks, and it must
// never be converted through a timezone. The GDS/Apollo/Sabre parsers
// already preserve this correctly as plain "YYYY-MM-DD" + "HH:MM" strings
// (see src/lib/parsers/shared.ts) with zero Date-object involvement.
//
// The only place a JS `Date` object gets involved at all is because
// Prisma's `departureAt`/`arrivalAt` columns are typed `DateTime` (chosen
// so `.getTime()` arithmetic — layover/duration calculations — stays cheap
// and correct). Where this went wrong previously: the write path
// constructed `new Date("2026-08-27T14:09:00")` — an ISO-shaped string
// with NO timezone suffix. Per the ECMA-262 spec, a date-time string with
// no offset is parsed as LOCAL TIME OF WHATEVER PROCESS RUNS THE CODE
// (the Node server's ambient `TZ`), not as the wall-clock value itself.
// Two independent display paths then each read that same stored instant
// back through their OWN timezone assumption — the CRM's plain
// `date-fns format()` uses local getters (which happened to cancel out the
// local-TZ write, by coincidence of running in the same process), while
// the email template explicitly forced `timeZone: "UTC"` (which did NOT
// cancel out), producing the reported discrepancy. That "cancels out by
// coincidence" behavior is also fragile on its own — deploying the CRM's
// SSR under a different `TZ` (e.g. a serverless platform defaulting to
// UTC) would have broken it too.
//
// The fix: treat these Date objects purely as portable containers for
// wall-clock numbers, written and read EXCLUSIVELY through their UTC
// getters/setters — never local ones, on either side. This makes the
// round-trip correct and deterministic regardless of what `TZ` the Node
// process actually runs under, in development, in CI, or in production.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Combines a parsed "YYYY-MM-DD" date and "HH:MM" (24h) time into a Date
 * object whose UTC calendar/clock fields hold exactly those numbers. This
 * is the ONLY place a FlightSegment's departureAt/arrivalAt should ever be
 * constructed from separate date/time components.
 */
export function toAirportDateTime(dateStr: string, timeStr: string): Date {
  return new Date(`${dateStr}T${timeStr}:00Z`);
}

/**
 * Same UTC-explicit interpretation as toAirportDateTime, for a call site
 * that already has the date and time combined into one naive
 * "YYYY-MM-DDTHH:MM:00" string (no timezone suffix) rather than the two
 * parts separately — e.g. a client payload built by simple string
 * concatenation. Idempotent: a string that already ends in "Z" is passed
 * through unchanged rather than getting a second "Z" appended.
 */
export function parseAirportDateTimeString(naive: string): Date {
  return new Date(naive.endsWith("Z") ? naive : `${naive}Z`);
}

/** "Thu, Aug 27" — reads the UTC calendar fields, never local ones. */
export function formatAirportDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "2:09 PM" — reads the UTC clock fields, never local ones. */
export function formatAirportTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
}

/** "Thu, Aug 27, 2:09 PM" — combined helper for contexts with no room for
 * two separate lines (e.g. a compact list row). */
export function formatAirportDateTime(d: Date): string {
  return `${formatAirportDate(d)}, ${formatAirportTime(d)}`;
}
