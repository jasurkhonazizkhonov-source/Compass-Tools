import { describe, it, expect } from "vitest";
import { toEmailSegments } from "../segment-mapper";

// Regression coverage for the "Aircraft information unavailable" placeholder
// fix — every email (customer-facing AND internal/staff) must omit the
// aircraft field entirely when no real aircraft type or raw GDS text
// exists; the fallback string must never appear anywhere. Mirrors
// flight-itinerary-display.tsx's own suppression logic.

function baseSegment(overrides: Partial<Parameters<typeof toEmailSegments>[0][number]> = {}) {
  return {
    flightNumber: "100",
    bookingClass: "Y",
    cabin: "ECONOMY",
    departureAt: new Date("2026-08-27T14:00:00Z"),
    arrivalAt: new Date("2026-08-27T16:00:00Z"),
    durationMinutes: 120,
    airlineCodeRaw: "AA",
    connectionType: null,
    airline: { name: "American Airlines", iata: "AA", icao: "AAL", logoUrl: null },
    aircraftType: null,
    aircraftRaw: null,
    operatingCarrierName: null,
    departureAirport: { iata: "JFK", city: "New York" },
    arrivalAirport: { iata: "LAX", city: "Los Angeles" },
    isExtraLeg: false,
    ...overrides,
  };
}

describe("toEmailSegments — aircraft fallback is never shown, anywhere", () => {
  it("omits the aircraft field entirely (empty string) when no aircraft type or raw text exists", () => {
    const [segment] = toEmailSegments([baseSegment()]);
    expect(segment.aircraft).toBe("");
    expect(segment.aircraft).not.toBe("Aircraft information unavailable");
  });

  it("still shows a real aircraft type when one exists", () => {
    const [segment] = toEmailSegments([baseSegment({ aircraftType: { displayName: "Boeing 737-800" } })]);
    expect(segment.aircraft).toBe("Boeing 737-800");
  });

  it("still shows raw GDS aircraft text when no reference-table match exists", () => {
    const [segment] = toEmailSegments([baseSegment({ aircraftRaw: "73H" })]);
    expect(segment.aircraft).toBe("73H");
  });
});

// Pass 11 Part 2 — departureTimezone/arrivalTimezone must flow through
// from the Airport reference data (SEGMENT_SELECT) into EmailSegment so
// renderItineraryHtml's Total Journey Summary/Connection calculation is
// timezone-aware, not a naive same-zone fallback.
describe("toEmailSegments — timezone passthrough for calculateJourneyDuration", () => {
  it("maps departureAirport.timezone/arrivalAirport.timezone onto the resulting EmailSegment", () => {
    const [segment] = toEmailSegments([
      baseSegment({
        departureAirport: { iata: "JFK", city: "New York", timezone: "America/New_York" },
        arrivalAirport: { iata: "LHR", city: "London", timezone: "Europe/London" },
      }),
    ]);
    expect(segment.departureTimezone).toBe("America/New_York");
    expect(segment.arrivalTimezone).toBe("Europe/London");
  });

  it("degrades gracefully to undefined when an airport has no timezone on file yet", () => {
    const [segment] = toEmailSegments([baseSegment()]);
    expect(segment.departureTimezone).toBeUndefined();
    expect(segment.arrivalTimezone).toBeUndefined();
  });
});
