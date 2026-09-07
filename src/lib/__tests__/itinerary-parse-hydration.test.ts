import { describe, it, expect, vi } from "vitest";
import type { ParsedSegment } from "@/lib/parsers/shared";

// Portability pass, Item 10 — hydrateParsedSegments is the shared bridge
// between the pure GDS parsers (raw string codes) and the itinerary
// builder's EditableSegment shape (real, resolved Airport/Airline/Aircraft
// records) — used identically by quote-builder.tsx and exchange-builder.tsx
// for both Sabre/SWAN and Apollo input. It had no dedicated test of its own
// before this pass (the parsers themselves are well covered; this file
// covers the resolution/warning/connection-defaulting logic that sits
// between a successful parse and what actually reaches the UI).

const airports: Record<string, { id: number; iata: string; name: string; city: string; country: string; timezone: string }> = {
  FRA: { id: 1, iata: "FRA", name: "Frankfurt Airport", city: "Frankfurt", country: "Germany", timezone: "Europe/Berlin" },
  JFK: { id: 2, iata: "JFK", name: "John F Kennedy Intl", city: "New York", country: "United States", timezone: "America/New_York" },
};
const airlines: Record<string, { id: number; name: string; iata: string; icao: string | null; logoUrl: string | null }> = {
  LH: { id: 10, name: "Lufthansa", iata: "LH", icao: "DLH", logoUrl: null },
};

vi.mock("@/server/queries/reference-data", () => ({
  resolveAirportCodes: vi.fn(async (codes: string[]) => {
    const map: Record<string, unknown> = {};
    for (const c of codes) map[c] = airports[c.toUpperCase()] ?? null;
    return map;
  }),
  resolveAirlineCodes: vi.fn(async (codes: string[]) => {
    const map: Record<string, unknown> = {};
    for (const c of codes) map[c] = airlines[c.toUpperCase()] ?? null;
    return map;
  }),
  resolveAircraftCodes: vi.fn(async (codes: string[]) => {
    const map: Record<string, unknown> = {};
    for (const c of codes) map[c] = null;
    return map;
  }),
}));

const { hydrateParsedSegments } = await import("../itinerary-parse-hydration");

function seg(overrides: Partial<ParsedSegment>): ParsedSegment {
  return {
    sequence: 1,
    raw: "",
    warnings: [],
    uncertainFields: [],
    ...overrides,
  } as ParsedSegment;
}

describe("hydrateParsedSegments", () => {
  it("resolves known airport and airline codes into real, id-bearing records", async () => {
    const [hydrated] = await hydrateParsedSegments(
      [seg({ departureAirport: "FRA", arrivalAirport: "JFK", airlineCode: "LH", flightNumber: "400" })],
      "ECONOMY"
    );
    expect(hydrated.departureAirport?.iata).toBe("FRA");
    expect(hydrated.arrivalAirport?.iata).toBe("JFK");
    expect(hydrated.airline?.name).toBe("Lufthansa");
  });

  it("flags an unresolvable airport code with a warning and uncertainFields entry, but never throws or blocks the segment", async () => {
    const [hydrated] = await hydrateParsedSegments(
      [seg({ departureAirport: "ZZZ", arrivalAirport: "JFK", flightNumber: "1" })],
      "ECONOMY"
    );
    expect(hydrated.departureAirport).toBeNull();
    expect(hydrated.uncertainFields).toContain("departureAirport");
    expect(hydrated.warnings.some((w) => w.field === "departureAirport")).toBe(true);
  });

  it("flags an unresolvable airline code the same way, keeping the raw code for display", async () => {
    const [hydrated] = await hydrateParsedSegments([seg({ airlineCode: "ZZ", flightNumber: "1" })], "ECONOMY");
    expect(hydrated.airline).toBeNull();
    expect(hydrated.airlineCodeRaw).toBe("ZZ");
    expect(hydrated.uncertainFields).toContain("airline");
  });

  it("never invents a missing arrival date by defaulting it to the departure date", async () => {
    const [hydrated] = await hydrateParsedSegments([seg({ departureDate: "2026-09-04", arrivalDate: undefined })], "ECONOMY");
    expect(hydrated.arrivalDate).toBe("");
  });

  it("defaults the connection type to LAYOVER when the gap between two segments is short (a real connection, not a separate leg)", async () => {
    const hydrated = await hydrateParsedSegments(
      [
        seg({ departureAirport: "FRA", arrivalAirport: "JFK", arrivalDate: "2026-09-04", arrivalTime: "14:00" }),
        seg({ departureAirport: "JFK", arrivalAirport: "FRA", departureDate: "2026-09-04", departureTime: "16:00" }),
      ],
      "ECONOMY"
    );
    expect(hydrated[1].connectionType).toBe("LAYOVER");
  });

  it("does not default a connection type when the gap between segments is long (a separate leg, e.g. a return flight days later)", async () => {
    const hydrated = await hydrateParsedSegments(
      [
        seg({ departureAirport: "FRA", arrivalAirport: "JFK", arrivalDate: "2026-09-04", arrivalTime: "14:00" }),
        seg({ departureAirport: "JFK", arrivalAirport: "FRA", departureDate: "2026-09-20", departureTime: "16:00" }),
      ],
      "ECONOMY"
    );
    expect(hydrated[1].connectionType).toBeUndefined();
  });

  it("applies the caller-supplied default cabin when the parser produced no cabin guess", async () => {
    const [hydrated] = await hydrateParsedSegments([seg({ cabinGuess: undefined })], "BUSINESS");
    expect(hydrated.cabin).toBe("BUSINESS");
  });

  it("resolves an empty parsed-segment list to an empty hydrated list without touching reference-data at all", async () => {
    const hydrated = await hydrateParsedSegments([], "ECONOMY");
    expect(hydrated).toEqual([]);
  });
});
