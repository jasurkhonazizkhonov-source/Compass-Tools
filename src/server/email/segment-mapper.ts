import type { EmailSegment } from "./templates";
import { resolveAirlineDisplay, resolveAircraftDisplay, resolveOperatingCarrierLabel, type AirlineRef, type AircraftRef } from "@/lib/canonical-segment";

type SegmentWithRelations = {
  id?: string;
  flightNumber: string;
  bookingClass: string | null;
  cabin: string;
  departureAt: Date;
  arrivalAt: Date;
  durationMinutes: number | null;
  airlineCodeRaw: string | null;
  connectionType: string | null;
  airline: AirlineRef;
  aircraftType: AircraftRef;
  aircraftRaw: string | null;
  operatingCarrierName?: string | null;
  departureAirport: { iata: string; city: string; timezone?: string | null };
  arrivalAirport: { iata: string; city: string; timezone?: string | null };
  isExtraLeg?: boolean;
};

/** Maps Prisma flight-segment rows to the plain shape email templates
 * render — real database data only, never fabricated. Airline/aircraft
 * fallback resolution goes through canonical-segment.ts, the same module
 * flight-itinerary-display.tsx (the CRM/customer UI) uses, so an email and
 * the CRM can never show a different resolved value for the same segment.
 *
 * When neither a real aircraft type nor raw GDS text exists, the aircraft
 * field is always left blank — every email (customer-facing or internal
 * staff notification) omits the aircraft line entirely rather than showing
 * resolveAircraftDisplay()'s "Aircraft information unavailable" fallback. */
export function toEmailSegments(segments: SegmentWithRelations[]): EmailSegment[] {
  return segments.map((s) => {
    const airline = resolveAirlineDisplay(s.airline, s.airlineCodeRaw);
    const hasNoAircraftData = !s.aircraftType?.displayName && !s.aircraftRaw;
    return {
      id: s.id,
      airlineName: airline.name,
      airlineCode: airline.code,
      airlineLogoUrl: airline.logoUrl,
      flightNumber: s.flightNumber,
      cabin: s.cabin.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      bookingClass: s.bookingClass,
      aircraft: hasNoAircraftData ? "" : resolveAircraftDisplay(s.aircraftType, s.aircraftRaw),
      operatingCarrierLabel: resolveOperatingCarrierLabel(s.operatingCarrierName),
      departureAirportCode: s.departureAirport.iata,
      departureCity: s.departureAirport.city,
      arrivalAirportCode: s.arrivalAirport.iata,
      arrivalCity: s.arrivalAirport.city,
      departureAt: s.departureAt,
      arrivalAt: s.arrivalAt,
      // Pass 11 Part 2 — for calculateJourneyDuration's timezone-aware
      // "Total journey time"/Connection calculation. See SEGMENT_SELECT.
      departureTimezone: s.departureAirport.timezone,
      arrivalTimezone: s.arrivalAirport.timezone,
      durationMinutes: s.durationMinutes,
      connectionType: s.connectionType === "LAYOVER" || s.connectionType === "MULTI_CITY" ? s.connectionType : null,
      isExtraLeg: s.isExtraLeg ?? false,
    };
  });
}
