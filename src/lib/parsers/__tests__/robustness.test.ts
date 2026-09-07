import { describe, it, expect } from "vitest";
import { parseApolloItinerary } from "../apollo";
import { parseSabreItinerary } from "../sabre";

describe("parser robustness — formatting variations", () => {
  it("handles airline and flight number as separate tokens", () => {
    const [seg] = parseApolloItinerary("1 BA 1460 25SEP LHREDI SS1 600P 725P", 2026);
    expect(seg.airlineCode).toBe("BA");
    expect(seg.flightNumber).toBe("1460");
  });

  it("extracts an IATA equipment/aircraft code when present", () => {
    const [seg] = parseSabreItinerary("1 LH400C 12MAR FRA-JFK HK1 1050A 130P 77W", 2026);
    expect(seg.aircraft).toBe("77W");
  });

  it("does not misclassify a 3-letter airport as an aircraft code", () => {
    const [seg] = parseSabreItinerary("1 LH400C 12MAR FRA-JFK HK1 1050A 130P", 2026);
    expect(seg.departureAirport).toBe("FRA");
    expect(seg.arrivalAirport).toBe("JFK");
    expect(seg.aircraft).toBeUndefined();
  });

  it("handles a one-way single segment cleanly with no spurious warnings", () => {
    const segments = parseApolloItinerary("1 AA100Y 10JAN JFKLAX SS1 800A 1130A", 2026);
    expect(segments).toHaveLength(1);
    // Booking class Y confidently maps to Economy — nothing left to confirm.
    expect(segments[0].warnings).toHaveLength(0);
    expect(segments[0].uncertainFields).toHaveLength(0);
  });

  it("handles a round trip (two segments, same route reversed)", () => {
    const segments = parseApolloItinerary(
      "1 BA1460Y 25SEP LHREDI SS1 600P 725P\n2 BA1465Y 07OCT EDILHR SS1 640A 815A",
      2026
    );
    expect(segments).toHaveLength(2);
    expect(segments[0].departureAirport).toBe(segments[1].arrivalAirport);
    expect(segments[1].departureAirport).toBe(segments[0].arrivalAirport);
  });

  it("handles a multi-city itinerary (three distinct legs)", () => {
    const segments = parseApolloItinerary(
      `1 AA100Y 10JAN JFKLAX SS1 800A 1130A
2 AA200Y 12JAN LAXSFO SS1 200P 320P
3 AA300Y 15JAN SFOJFK SS1 500P 130A`,
      2026
    );
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.departureAirport)).toEqual(["JFK", "LAX", "SFO"]);
  });

  it("keeps the arrival date on the same calendar day when no explicit day-offset marker is present — real GDS output always marks a genuine day change explicitly (see next-day-arrival.test.ts)", () => {
    const [seg] = parseApolloItinerary("1 EK202Y 15DEC JFKDXB SS1 1130P 800A", 2026);
    expect(seg.departureDate).toBe("2026-12-15");
    expect(seg.arrivalDate).toBe("2026-12-15");
  });

  it("flags missing arrival time instead of guessing it", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHREDI SS1 600P", 2026);
    expect(seg.arrivalTime).toBeUndefined();
    expect(seg.uncertainFields).toContain("arrivalTime");
    expect(seg.warnings.some((w) => w.message === "Arrival time could not be determined")).toBe(true);
  });

  it("flags missing departure time instead of guessing it", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHREDI SS1", 2026);
    expect(seg.departureTime).toBeUndefined();
    expect(seg.uncertainFields).toContain("departureTime");
  });

  it("flags a missing airline separately from a missing flight number", () => {
    const [seg] = parseApolloItinerary("1 25SEP LHREDI SS1 600P 725P", 2026);
    expect(seg.airlineCode).toBeUndefined();
    expect(seg.uncertainFields).toContain("airline");
    expect(seg.uncertainFields).toContain("flightNumber");
  });

  it("tolerates lowercase input", () => {
    const [seg] = parseApolloItinerary("1 ba1460y 25sep lhredi ss1 600p 725p", 2026);
    expect(seg.airlineCode).toBe("BA");
    expect(seg.departureAirport).toBe("LHR");
    expect(seg.departureTime).toBe("18:00");
  });

  it("tolerates irregular whitespace between tokens", () => {
    const [seg] = parseApolloItinerary("1    BA1460Y     25SEP   LHREDI  SS1   600P   725P", 2026);
    expect(seg.airlineCode).toBe("BA");
    expect(seg.departureAirport).toBe("LHR");
  });

  it("does not misinterpret LHREDI as a single airport code", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHREDI SS1 600P 725P", 2026);
    expect(seg.departureAirport).toHaveLength(3);
    expect(seg.arrivalAirport).toHaveLength(3);
    expect(seg.departureAirport).not.toBe(seg.arrivalAirport);
  });

  it("ignores unparseable lines without throwing", () => {
    expect(() => parseApolloItinerary("total nonsense that matches nothing at all here", 2026)).not.toThrow();
  });
});
