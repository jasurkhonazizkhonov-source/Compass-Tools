import { describe, it, expect } from "vitest";
import { resolveAircraftDisplay, resolveAirlineDisplay, resolveOperatingCarrierLabel } from "../canonical-segment";

describe("resolveAircraftDisplay", () => {
  it("prefers the matched AircraftType display name", () => {
    expect(resolveAircraftDisplay({ displayName: "Boeing 737-800" }, "738")).toBe("Boeing 737-800");
  });

  it("falls back to the raw parsed equipment code when no reference match exists (real source data, not a guess)", () => {
    expect(resolveAircraftDisplay(null, "XYZ")).toBe("XYZ");
  });

  it("returns the explicit unavailable message when there is no aircraft data at all — never invents a type", () => {
    expect(resolveAircraftDisplay(null, null)).toBe("Aircraft information unavailable");
  });

  it("never returns null — callers can render it unconditionally", () => {
    expect(resolveAircraftDisplay(null, null)).not.toBeNull();
  });
});

describe("resolveAirlineDisplay", () => {
  it("prefers the matched Airline reference name/code", () => {
    const result = resolveAirlineDisplay({ name: "Philippine Airlines", iata: "PR", icao: null, logoUrl: null }, "PR");
    expect(result.name).toBe("Philippine Airlines");
    expect(result.code).toBe("PR");
  });

  it("falls back to the raw code when no reference match exists", () => {
    const result = resolveAirlineDisplay(null, "XY");
    expect(result.name).toBe("XY");
    expect(result.code).toBe("XY");
  });

  // Database-portability pass — logo regression coverage (Test E). The
  // underlying fallback logic here was always correct; the bug that
  // actually shipped (found live, against a genuinely fresh database with
  // no curated Airline.logoUrl rows) was a SEPARATE component
  // (flight-itinerary-display.tsx's <AirlineLogo>) reading the raw
  // database column directly instead of this function's resolved value —
  // fixed there, not here. These tests guard the piece this pure-function
  // test suite CAN cover: that the fallback computation itself is and
  // remains correct, independent of whatever the current Postgres
  // instance's Airline.logoUrl column happens to contain.
  it("falls back to a CDN-derived logo URL by IATA code when the database column is null (no curated logo required)", () => {
    const result = resolveAirlineDisplay({ name: "Cathay Pacific", iata: "CX", icao: "CPA", logoUrl: null }, "CX");
    expect(result.logoUrl).toBe("https://images.kiwi.com/airlines/64x64/CX.png");
  });

  it("an explicit database logoUrl always wins over the CDN fallback", () => {
    const result = resolveAirlineDisplay({ name: "Cathay Pacific", iata: "CX", icao: "CPA", logoUrl: "https://cdn.example.com/custom-cx-logo.png" }, "CX");
    expect(result.logoUrl).toBe("https://cdn.example.com/custom-cx-logo.png");
  });

  it("returns no logo URL at all when there's no airline reference row and no IATA code to derive one from", () => {
    const result = resolveAirlineDisplay(null, "XY");
    expect(result.logoUrl).toBeNull();
  });
});

describe("resolveOperatingCarrierLabel", () => {
  it("formats a present operating carrier", () => {
    expect(resolveOperatingCarrierLabel("PAL EXPRESS")).toBe("Operated by PAL EXPRESS");
  });

  it("returns null (never an empty string) when absent", () => {
    expect(resolveOperatingCarrierLabel(null)).toBeNull();
    expect(resolveOperatingCarrierLabel(undefined)).toBeNull();
    expect(resolveOperatingCarrierLabel("   ")).toBeNull();
  });
});
