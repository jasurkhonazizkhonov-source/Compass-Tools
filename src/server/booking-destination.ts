/**
 * The destination shown in the internal "Notify Team of a New Sale / Cancellation" subject and body, derived from the
 * itinerary: the arrival city and country of the LAST real leg — extra legs (positioning / add-on segments) are skipped,
 * and a multi-city trip therefore reports its final stop. When every leg is flagged extra the last leg is used; with no
 * legs at all the fixed fallback below is returned. Shared by both notifications so they can never disagree.
 */
export const UNSPECIFIED_DESTINATION = "an unspecified destination";

export function deriveNotificationDestination(
  segments: ReadonlyArray<{ isExtraLeg: boolean; arrivalAirport: { city: string; country: string } }>
): string {
  const last = [...segments].reverse().find((s) => !s.isExtraLeg) ?? segments[segments.length - 1];
  return last ? `${last.arrivalAirport.city}, ${last.arrivalAirport.country}` : UNSPECIFIED_DESTINATION;
}
