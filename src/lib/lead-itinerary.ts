import { z } from "zod";

/**
 * The shape of a lead's travel request as the CRM handles it.
 *
 * One-way and round-trip leads use the departure/arrival/date fields on the
 * Lead itself. A MULTI_CITY lead additionally has an ORDERED list of segments
 * (LeadSegment rows) — and for such a lead those lead-level fields mirror the
 * FIRST segment, so every consumer that only understands one route (sequence
 * variables, the quote prefill, searches) keeps working and simply sees the
 * first leg. Anything that wants the whole itinerary reads the segments.
 */

export const MAX_LEAD_SEGMENTS = 8;

export type LeadSegmentInput = {
  departureAirportId: number | null;
  arrivalAirportId: number | null;
  /** yyyy-MM-dd, or null when not set. */
  departureDate: string | null;
};

/** What the Travel Request editor sends to setLeadSegments. Validated again on the server. */
export const leadSegmentsSchema = z
  .array(
    z.object({
      departureAirportId: z.number().int().positive().nullable(),
      arrivalAirportId: z.number().int().positive().nullable(),
      departureDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be yyyy-MM-dd")
        .nullable(),
    })
  )
  .min(1, "A multi-city request needs at least one flight segment")
  .max(MAX_LEAD_SEGMENTS, `A request can have at most ${MAX_LEAD_SEGMENTS} segments`);

/** The lead-level columns that mirror the first segment. */
export function mirrorFromSegments(segments: LeadSegmentInput[]): {
  departureAirportId: number | null;
  arrivalAirportId: number | null;
  departureDate: Date | null;
  returnDate: null;
} {
  const first = segments[0];
  return {
    departureAirportId: first?.departureAirportId ?? null,
    arrivalAirportId: first?.arrivalAirportId ?? null,
    departureDate: first?.departureDate ? new Date(first.departureDate) : null,
    // A multi-city request has no single "return": every leg is a segment.
    returnDate: null,
  };
}

type RouteAirport = { iata: string } | null | undefined;
type RouteSegment = { departureAirport?: RouteAirport; arrivalAirport?: RouteAirport };

/**
 * "JFK → LHR → CDG → JFK": the whole chain of a multi-city itinerary, joining
 * consecutive legs where one ends where the next begins (the usual case) and
 * otherwise showing the break ("JFK → LHR · CDG → JFK"). Unknown airports show
 * as "?". Returns null when there are no segments.
 */
export function segmentsRouteLabel(segments: RouteSegment[]): string | null {
  if (segments.length === 0) return null;
  const code = (a: RouteAirport) => a?.iata ?? "?";
  let out = "";
  let prevArrival: string | null = null;
  segments.forEach((seg, i) => {
    const dep = code(seg.departureAirport);
    const arr = code(seg.arrivalAirport);
    if (i === 0) out = `${dep} → ${arr}`;
    else if (prevArrival === dep) out += ` → ${arr}`;
    else out += ` · ${dep} → ${arr}`;
    prevArrival = arr;
  });
  return out;
}

/** The route text for a lead row/header: the full chain for a multi-city lead that has segments, else "A → B". */
export function leadRouteLabel(lead: { tripType: string; departureAirport?: RouteAirport; arrivalAirport?: RouteAirport; segments?: RouteSegment[] }): string {
  if (lead.tripType === "MULTI_CITY" && lead.segments && lead.segments.length > 0) {
    return segmentsRouteLabel(lead.segments) ?? "—";
  }
  return `${lead.departureAirport?.iata ?? "—"} → ${lead.arrivalAirport?.iata ?? "—"}`;
}
