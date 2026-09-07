import type { Prisma } from "@/generated/prisma/client";

/**
 * The one canonical field/relation selection for a FlightSegment row, used
 * by every query that fetches itinerary segments — the CRM quote/booking
 * detail pages, the initial quote email, the booking-confirmation email,
 * and the customer-facing quote/booking/confirmation pages. Before this
 * existed, each of those five call sites independently hand-typed the same
 * `{ departureAirport, arrivalAirport, airline, aircraftType, ... }` shape;
 * adding a new segment field (like operatingCarrierName) to only some of
 * them is exactly how the CRM and a customer email can end up showing a
 * different itinerary for the same segment. Every call site below imports
 * this instead of repeating the shape.
 *
 * Works identically whether the outer query uses `include` or `select` —
 * Prisma accepts `select` on a nested relation either way, so this one
 * object also serves the customer-facing `getQuoteByToken` query, which
 * uses an explicit top-level `select` (not `include`) for its own,
 * unrelated reason (excluding internal-only Quote columns).
 */
export const SEGMENT_SELECT = {
  id: true,
  sequence: true,
  connectionType: true,
  flightNumber: true,
  bookingClass: true,
  cabin: true,
  departureAt: true,
  arrivalAt: true,
  durationMinutes: true,
  airlineCodeRaw: true,
  aircraftRaw: true,
  operatingCarrierName: true,
  isExtraLeg: true,
  airline: { select: { name: true, iata: true, icao: true, logoUrl: true } },
  aircraftType: { select: { displayName: true } },
  // Pass 11 Part 2 — timezone is required for the ONE centralized
  // "total journey time"/connection-duration calculation
  // (calculateJourneyDuration in src/lib/flight-duration.ts) to be
  // timezone-aware rather than falling back to naive same-zone
  // subtraction. Selecting it here, in the one canonical shape every
  // itinerary query already imports, means every render path (CRM,
  // View Deal, email, exchange, cancellation) gets it for free.
  departureAirport: { select: { iata: true, name: true, city: true, country: true, timezone: true } },
  arrivalAirport: { select: { iata: true, name: true, city: true, country: true, timezone: true } },
} satisfies Prisma.FlightSegmentSelect;
