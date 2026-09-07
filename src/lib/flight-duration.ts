// Root cause of the reported ~19h Dallas -> Athens duration bug: every
// duration calculation in this app (quote-builder.tsx's save-time compute,
// flight-segment-editor.tsx's live preview) subtracted two naive
// "YYYY-MM-DDTHH:mm:ss" datetime strings directly — each one is really the
// LOCAL WALL-CLOCK time at its OWN airport (per airport-datetime.ts's
// documented convention), not a shared timezone. Subtracting two airport-
// local readings as if they were the same instant produces a duration
// that's off by roughly the difference between the two airports' UTC
// offsets. A real ~11h DFW (UTC-5 in August) -> ATH (UTC+3) flight departing
// 18:00 local and arriving 13:00 local the next day: naive subtraction
// gives 13:00(+1 day) - 18:00 = -5h + 24h = 19h — exactly the reported bug.
//
// The fix: convert EACH side through its OWN airport's real IANA timezone
// into a true UTC instant (via date-fns-tz's fromZonedTime) before
// subtracting. This requires an actual timezone identifier per airport —
// see Airport.timezone in prisma/schema.prisma (backfilled from each
// airport's existing latitude/longitude via scripts/backfill-airport-timezones.ts
// using the tz-lookup library; prisma/seed.ts populates it for fresh seeds
// going forward too).

import { fromZonedTime } from "date-fns-tz";

/**
 * True elapsed flight time in minutes between a departure and arrival,
 * each given as a naive "YYYY-MM-DDTHH:mm(:ss)?" wall-clock string (no
 * timezone suffix) plus that airport's own IANA timezone identifier.
 *
 * Falls back to naive same-zone subtraction (the pre-fix behavior) when
 * either airport's timezone is unknown — strictly better than throwing,
 * though duration accuracy for that specific route degrades the same way
 * the original bug did. Should be rare once Airport.timezone is populated.
 */
export function calculateFlightDurationMinutes(
  departureNaiveDatetime: string,
  departureTimezone: string | null | undefined,
  arrivalNaiveDatetime: string,
  arrivalTimezone: string | null | undefined
): number {
  if (!departureTimezone || !arrivalTimezone) {
    return Math.round((new Date(arrivalNaiveDatetime).getTime() - new Date(departureNaiveDatetime).getTime()) / 60000);
  }
  const departureUtc = fromZonedTime(departureNaiveDatetime, departureTimezone);
  const arrivalUtc = fromZonedTime(arrivalNaiveDatetime, arrivalTimezone);
  return Math.round((arrivalUtc.getTime() - departureUtc.getTime()) / 60000);
}

// ═══════════════════════════════════════════════════════════════════════
// Pass 11 Part 2 — the ONE centralized "total journey time" calculation,
// reused by the CRM/View Deal itinerary component, the email itinerary
// renderer, exchange quotes (both the original and proposed itinerary),
// and cancellation quotes. Every consumer must go through this — no
// presentation-layer duration/layover math anywhere else in the app.
//
// "Flight duration" (one leg's own scheduled flying time) and "Total
// journey time" (first departure -> final arrival, INCLUDING every
// connection) are deliberately two different numbers, computed two
// different ways here:
//   - totalJourneyMinutes is ONE direct, timezone-aware datetime
//     subtraction (first segment's departure instant vs. last segment's
//     arrival instant) — never a sum of the per-leg figures below, so a
//     connection can never be double-counted (see the explicit
//     "8h45+4h45+2h00=15h30, never 20h15" regression test).
//   - each leg's flightDurationMinutes prefers the segment's own stored/
//     agent-corrected durationMinutes (the authoritative value the quote
//     builder already computes and lets an agent override — see
//     quote-builder.tsx/flight-segment-editor.tsx), falling back to the
//     same timezone-aware calculation only when that's unavailable.
// ═══════════════════════════════════════════════════════════════════════

/** Converts an airport-local wall-clock Date (stored per airport-datetime.ts's
 * documented UTC-getter/setter convention — the Date's UTC fields hold the
 * airport's own local clock reading, not a real UTC instant) back into the
 * naive "YYYY-MM-DDTHH:mm:ss" string calculateFlightDurationMinutes expects. */
function toNaiveLocalString(d: Date): string {
  return d.toISOString().slice(0, 19);
}

export type JourneyLegInput = {
  departureAt: Date;
  arrivalAt: Date;
  /** Airport.timezone (IANA identifier) — see prisma/schema.prisma's Airport
   * model and segment-select.ts's SEGMENT_SELECT, which is the one place
   * this must be fetched from for every itinerary-rendering call site. */
  departureTimezone?: string | null;
  arrivalTimezone?: string | null;
  /** The segment's own authoritative flight duration, when known (stored
   * FlightSegment.durationMinutes, possibly agent-corrected). Preferred
   * over recomputing from departureAt/arrivalAt when present. */
  durationMinutes?: number | null;
};

export type JourneyLegBreakdown = {
  /** This leg's own scheduled flying time — "Flight duration" in the UI,
   * never to be confused with totalJourneyMinutes below. */
  flightDurationMinutes: number;
  /** Minutes on the ground before the NEXT segment departs — null for the
   * itinerary's final segment (nothing follows it). "Connection" in the
   * UI when present; the leg is "Nonstop" when every value in the whole
   * journey is null (a single-segment leg). */
  connectionMinutesAfter: number | null;
};

export type JourneyDuration = {
  /** First departure -> final arrival, INCLUDING every connection —
   * "Total journey time" in the UI. */
  totalJourneyMinutes: number;
  legs: JourneyLegBreakdown[];
};

/**
 * The single centralized itinerary-duration calculation — computes both
 * the per-leg "Flight duration"/"Connection" breakdown AND the overall
 * "Total journey time" for one directional itinerary (e.g. just the
 * outbound segments, or just the return segments — pass one direction at
 * a time, not a whole round trip flattened together). Returns null for an
 * empty segment list.
 */
export function calculateJourneyDuration(segments: JourneyLegInput[]): JourneyDuration | null {
  if (segments.length === 0) return null;
  const first = segments[0];
  const last = segments[segments.length - 1];

  // Pass 15 — nonstop (single-segment) special case. The general rule above
  // ("totalJourneyMinutes is ONE direct subtraction, never a sum of the
  // per-leg figures") exists specifically to avoid double-counting a
  // connection — but with exactly one segment there is no connection to
  // double-count, and the leg's own authoritative flightDurationMinutes
  // (below: the segment's stored/agent-corrected durationMinutes,
  // preferred over recomputing) and the journey total are the SAME number
  // by definition — there is only one flight. Previously this branch was
  // unconditionally recomputed from the raw departure/arrival timestamps,
  // so a nonstop segment with an agent-corrected durationMinutes override
  // (see FlightSegment.durationOverrideMinutes) would show a "Total journey
  // time · Nonstop" header that DISAGREED with the "Flight duration" shown
  // on the very same segment card right below it — the header silently
  // re-showed the exact figure the override exists to correct. Found live
  // while visually QA'ing the quote email (Pass 15 §37) with a fixture
  // whose durationMinutes intentionally diverged from the raw timestamp
  // diff; the existing single-segment test happened to use a fixture where
  // both numbers coincided, so it never caught this. Multi-segment journeys
  // are completely unaffected — they still use the pure, timezone-aware
  // first-departure -> final-arrival subtraction below.
  const totalJourneyMinutes =
    segments.length === 1 && first.durationMinutes != null
      ? first.durationMinutes
      : calculateFlightDurationMinutes(
          toNaiveLocalString(first.departureAt),
          first.departureTimezone,
          toNaiveLocalString(last.arrivalAt),
          last.arrivalTimezone
        );

  const legs: JourneyLegBreakdown[] = segments.map((seg, i) => {
    const flightDurationMinutes =
      seg.durationMinutes ??
      calculateFlightDurationMinutes(toNaiveLocalString(seg.departureAt), seg.departureTimezone, toNaiveLocalString(seg.arrivalAt), seg.arrivalTimezone);

    const next = segments[i + 1];
    const connectionMinutesAfter = next
      ? calculateFlightDurationMinutes(toNaiveLocalString(seg.arrivalAt), seg.arrivalTimezone, toNaiveLocalString(next.departureAt), next.departureTimezone)
      : null;

    return { flightDurationMinutes, connectionMinutesAfter };
  });

  return { totalJourneyMinutes, legs };
}
