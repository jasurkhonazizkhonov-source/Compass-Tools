import { describe, it, expect } from "vitest";
import { parseApolloItinerary } from "../apollo";

const SAMPLE = `1 BA1460Y 25SEP LHREDI SS1 600P 725P * FR E
2 BA1465Y 07OCT EDILHR SS1 640A 815A * WE E`;

describe("parseApolloItinerary", () => {
  it("parses both segments of the canonical sample", () => {
    const segments = parseApolloItinerary(SAMPLE, 2026);
    expect(segments).toHaveLength(2);
  });

  it("correctly extracts the first segment", () => {
    const [seg] = parseApolloItinerary(SAMPLE, 2026);
    expect(seg.airlineCode).toBe("BA");
    expect(seg.flightNumber).toBe("1460");
    expect(seg.bookingClass).toBe("Y");
    expect(seg.departureAirport).toBe("LHR");
    expect(seg.arrivalAirport).toBe("EDI");
    expect(seg.departureDate).toBe("2026-09-25");
    expect(seg.departureTime).toBe("18:00");
    expect(seg.arrivalTime).toBe("19:25");
    expect(seg.dayOfWeek).toBe("FR");
  });

  it("correctly extracts the second (return) segment", () => {
    const [, seg] = parseApolloItinerary(SAMPLE, 2026);
    expect(seg.airlineCode).toBe("BA");
    expect(seg.flightNumber).toBe("1465");
    expect(seg.departureAirport).toBe("EDI");
    expect(seg.arrivalAirport).toBe("LHR");
    expect(seg.departureDate).toBe("2026-10-07");
    expect(seg.departureTime).toBe("06:40");
    expect(seg.arrivalTime).toBe("08:15");
  });

  it("does not misinterpret the flight+route token as one combined airport", () => {
    const [seg] = parseApolloItinerary(SAMPLE, 2026);
    expect(seg.departureAirport).not.toBe(seg.arrivalAirport);
    expect(seg.departureAirport).toHaveLength(3);
    expect(seg.arrivalAirport).toHaveLength(3);
  });

  it("keeps the arrival date on the same calendar day when no explicit day-offset marker is present, even though the arrival clock reads earlier than departure — see src/lib/parsers/__tests__/next-day-arrival.test.ts's 'exact reported bug report' describe block for the full reasoning", () => {
    const line = "1 EK202Y 15DEC JFKDXB SS1 1130P 800A FR E";
    const [seg] = parseApolloItinerary(line, 2026);
    expect(seg.departureDate).toBe("2026-12-15");
    expect(seg.arrivalDate).toBe("2026-12-15");
    expect(seg.departureTime).toBe("23:30");
    expect(seg.arrivalTime).toBe("08:00");
  });

  it("flags missing fields instead of guessing on malformed input", () => {
    const malformed = "1 BADLINE XX 999";
    const [seg] = parseApolloItinerary(malformed, 2026);
    expect(seg.warnings.length).toBeGreaterThan(0);
    expect(seg.departureAirport).toBeUndefined();
  });

  it("handles multiple segments for a multi-city itinerary", () => {
    const multiCity = `1 AA100Y 10JAN JFKLAX SS1 800A 1130A * SA E
2 AA200Y 12JAN LAXSFO SS1 200P 320P * MO E
3 AA300Y 15JAN SFOJFK SS1 500P 130A * TH E`;
    const segments = parseApolloItinerary(multiCity, 2026);
    expect(segments).toHaveLength(3);
    // Segment 3's arrival clock (1:30 AM) reads earlier than departure
    // (5:00 PM) with no explicit day-offset marker on the line — defaults
    // to the same day and is flagged uncertain for the agent to confirm
    // (see next-day-arrival.test.ts's "exact reported bug report" block).
    expect(segments[2].arrivalDate).toBe("2026-01-15");
    expect(segments[2].uncertainFields).toContain("arrivalDate");
  });

  it("extracts an IATA equipment/aircraft code through the Apollo entry point specifically (already covered for Sabre in robustness.test.ts — this closes the same gap for Apollo, since aircraft-code extraction is shared logic in gds-line.ts, not duplicated here)", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHREDI SS1 600P 725P 320 * FR E", 2026);
    expect(seg.aircraft).toBe("320");
  });

  it("ignores blank lines", () => {
    const withBlanks = `1 BA1460Y 25SEP LHREDI SS1 600P 725P * FR E\n\n\n2 BA1465Y 07OCT EDILHR SS1 640A 815A * WE E`;
    const segments = parseApolloItinerary(withBlanks, 2026);
    expect(segments).toHaveLength(2);
  });
});
