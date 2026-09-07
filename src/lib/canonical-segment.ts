// Single source of truth for deriving DISPLAY values (airline name/code,
// aircraft name, operating-carrier line) from a raw FlightSegment row —
// used by BOTH the CRM/customer-facing UI (flight-itinerary-display.tsx)
// and the email templates (segment-mapper.ts). Before this module existed,
// each of those two call sites independently re-implemented the same
// airline/aircraft fallback chains; if they ever drifted apart, the CRM
// and a customer's email could show a different-looking itinerary for the
// exact same underlying segment even though the raw data was identical.
// Routing both through these functions makes that class of bug structurally
// impossible — there is now only one place this logic can be wrong.

import { airlineLogoUrl } from "@/lib/airline-logo";

export type AirlineRef = { name: string; iata: string | null; icao: string | null; logoUrl: string | null } | null;
export type AircraftRef = { displayName: string } | null;

export function resolveAirlineDisplay(airline: AirlineRef, airlineCodeRaw: string | null) {
  return {
    name: airline?.name ?? airlineCodeRaw ?? "Airline to be confirmed",
    code: airline?.iata ?? airline?.icao ?? airlineCodeRaw ?? "",
    // An explicit DB value always wins; otherwise fall back to a
    // CDN-derived logo by IATA code (see lib/airline-logo.ts) rather than
    // showing no logo purely because nobody has ever set this column.
    logoUrl: airline?.logoUrl ?? airlineLogoUrl(airline?.iata),
  };
}

/**
 * Aircraft type, resolved through the AircraftType reference table when the
 * parsed equipment code matches a known entry. When it doesn't — either no
 * equipment code was present in the source GDS text, or the code didn't
 * match anything in the reference table — this deliberately does NOT guess
 * or invent an aircraft type; it returns a plain, honest fallback string so
 * every caller renders something explicit rather than silently omitting the
 * field. Never returns null so callers can render it unconditionally.
 */
export function resolveAircraftDisplay(aircraftType: AircraftRef, aircraftRaw: string | null): string {
  return aircraftType?.displayName ?? aircraftRaw ?? "Aircraft information unavailable";
}

/** The operating-carrier line, e.g. "Operated by PAL Express" — never
 * resolved against the Airline reference table (no verified logo/name
 * guessing for it), so the raw parsed/entered text is shown as-is or
 * nothing at all. Never returns an empty string, only a value or null, so
 * callers can use it directly in a conditional render. */
export function resolveOperatingCarrierLabel(operatingCarrierName: string | null | undefined): string | null {
  const trimmed = operatingCarrierName?.trim();
  return trimmed ? `Operated by ${trimmed}` : null;
}
