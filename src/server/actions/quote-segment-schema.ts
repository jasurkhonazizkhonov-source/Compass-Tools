import { z } from "zod";

// Plain (non-"use server") module: a Next.js "use server" file may only
// export async functions, so this Zod schema — shared between quotes.ts
// (create/send a quote) and exchange.ts (propose an exchange itinerary,
// same segment shape) — has to live outside either "use server" file
// rather than being re-exported from one, exactly like status-filter.ts's
// RSC-boundary fix earlier in this project.
export const segmentSchema = z.object({
  sequence: z.number(),
  departureAirportId: z.number(),
  arrivalAirportId: z.number(),
  departureAt: z.string(),
  arrivalAt: z.string(),
  airlineId: z.number().optional(),
  // Real GDS airline/flight/booking-class/equipment tokens are always a
  // handful of characters (see the AIRLINE_CODE_RE/FLIGHT_ONLY_RE/
  // EQUIPMENT_RE constraints in lib/parsers/gds-line.ts). operatingCarrierName
  // is the one genuinely free-text field here — it's lifted verbatim from a
  // GDS "OPERATED BY X" continuation line with no parser-side character or
  // length constraint (see parseGdsItinerary's OPERATED_BY_RE) — capped in
  // line with this codebase's existing free-text-field convention (see
  // company.ts's signatureTemplate/phone, payment-methods.ts's
  // referenceNote) so an adversarial or corrupted paste can't write an
  // unbounded string into every itinerary/segment row and email this quote
  // ever generates.
  airlineCodeRaw: z.string().max(10).optional(),
  flightNumber: z.string().min(1).max(10),
  bookingClass: z.string().max(5).optional(),
  cabin: z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]),
  aircraftTypeId: z.number().optional(),
  aircraftRaw: z.string().max(20).optional(),
  operatingCarrierName: z.string().max(200).optional(),
  // Part 3 — server-side sanity bound on a saved duration (auto-calculated
  // or a manual override — both flow through this same field, see
  // quote-builder.tsx/exchange-builder.tsx). 1440 min = 24h, comfortably
  // above the longest real nonstop commercial flight (~19h) and well below
  // an obviously-mistaken multi-day value; enforced here so an "impossible"
  // duration can never be saved regardless of client-side validation.
  durationMinutes: z.number().min(1).max(1440).optional(),
  connectionType: z.enum(["LAYOVER", "MULTI_CITY"]).optional(),
  isExtraLeg: z.boolean().optional(),
});
