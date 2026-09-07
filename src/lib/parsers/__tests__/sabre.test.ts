import { describe, it, expect } from "vitest";
import { parseSabreItinerary } from "../sabre";

describe("parseSabreItinerary", () => {
  it("parses a hyphenated city-pair format", () => {
    const text = "1 LH400C 12MAR FRA-JFK HK1 1050A 130P TH";
    const [seg] = parseSabreItinerary(text, 2026);
    expect(seg.airlineCode).toBe("LH");
    expect(seg.flightNumber).toBe("400");
    expect(seg.departureAirport).toBe("FRA");
    expect(seg.arrivalAirport).toBe("JFK");
    expect(seg.departureTime).toBe("10:50");
    expect(seg.arrivalTime).toBe("13:30");
  });

  it("tolerates extra spacing between tokens", () => {
    const text = "1   AF085Y   03NOV   JFK   CDG   HK1   700P   830A   *   WE";
    const [seg] = parseSabreItinerary(text, 2026);
    expect(seg.departureAirport).toBe("JFK");
    expect(seg.arrivalAirport).toBe("CDG");
    // Arrival clock (8:30 AM) reads earlier than departure (7:00 PM) with
    // no explicit day-offset marker — defaults to same day, flagged
    // uncertain (see next-day-arrival.test.ts's "exact reported bug
    // report" block for the full reasoning).
    expect(seg.arrivalDate).toBe("2026-11-03");
    expect(seg.uncertainFields).toContain("arrivalDate");
  });

  it("parses multiple segments across a round trip", () => {
    const text = `1 UA905Y 05JUN ORD-LHR HK1 615P 800A * SA
2 UA906Y 20JUN LHR-ORD HK1 1145A 230P FR`;
    const segments = parseSabreItinerary(text, 2026);
    expect(segments).toHaveLength(2);
    expect(segments[0].departureAirport).toBe("ORD");
    expect(segments[1].departureAirport).toBe("LHR");
  });

  it("handles a year boundary across segments", () => {
    const text = `1 QF001J 28DEC SYD-LAX HK1 945A 630A * WE
2 QF002J 03JAN LAX-SYD HK1 1030P 700A * FR`;
    const segments = parseSabreItinerary(text, 2026);
    expect(segments[0].departureDate).toBe("2026-12-28");
    expect(segments[1].departureDate).toBe("2027-01-03");
  });

  it("reports a warning instead of inventing a missing flight number", () => {
    const text = "1 unknown data here";
    const [seg] = parseSabreItinerary(text, 2026);
    expect(seg.airlineCode).toBeUndefined();
    expect(seg.warnings.some((w) => w.message === "Airline code could not be determined")).toBe(true);
    expect(seg.uncertainFields).toContain("airline");
  });

  it("returns an empty array for empty input", () => {
    expect(parseSabreItinerary("", 2026)).toEqual([]);
  });

  describe("exact spec regression — QR itinerary with a route glued directly to a status code", () => {
    // Sabre/SWAN "I" itinerary displays routinely fuse a "*" e-ticket/status
    // flag directly onto the preceding token with no space at all
    // ("SYDDOH*SS1"), unlike Apollo which only ever fuses "*" onto a time
    // ("535A2*"). This previously left the whole 6-letter route token
    // unrecognized (neither the route-pair nor the status-code pattern
    // matched "SYDDOH*SS1" as a single token), silently dropping both
    // airports even though every date/time field parsed correctly.
    const text = `1 QR 909I 07MAY 5 SYDDOH*SS1 2010 0400 08MAY 6 /DCQR /E*
2 QR 203I 08MAY 6 DOHATH*SS1 0745 1225 /DCQR /E
3 QR 20I 19JUN 6 DUBDOH*SS1 0815 1720 /DCQR /E*
4 QR 908I 19JUN 6 DOHSYD*SS1 2050 1755 20JUN 7 /DCQR`;
    const segments = parseSabreItinerary(text, 2026);

    it("parses all four segments with zero warnings", () => {
      expect(segments).toHaveLength(4);
      for (const seg of segments) {
        expect(seg.warnings).toEqual([]);
        expect(seg.uncertainFields).toEqual([]);
      }
    });

    it("QR 909: SYD -> DOH, May 7 8:10 PM -> May 8 4:00 AM", () => {
      expect(segments[0]).toMatchObject({
        airlineCode: "QR",
        flightNumber: "909",
        departureAirport: "SYD",
        arrivalAirport: "DOH",
        departureDate: "2026-05-07",
        departureTime: "20:10",
        arrivalDate: "2026-05-08",
        arrivalTime: "04:00",
      });
    });

    it("QR 203: DOH -> ATH, May 8 7:45 AM -> May 8 12:25 PM", () => {
      expect(segments[1]).toMatchObject({
        airlineCode: "QR",
        flightNumber: "203",
        departureAirport: "DOH",
        arrivalAirport: "ATH",
        departureDate: "2026-05-08",
        departureTime: "07:45",
        arrivalDate: "2026-05-08",
        arrivalTime: "12:25",
      });
    });

    it("QR 20: DUB -> DOH, June 19 8:15 AM -> June 19 5:20 PM", () => {
      expect(segments[2]).toMatchObject({
        airlineCode: "QR",
        flightNumber: "20",
        departureAirport: "DUB",
        arrivalAirport: "DOH",
        departureDate: "2026-06-19",
        departureTime: "08:15",
        arrivalDate: "2026-06-19",
        arrivalTime: "17:20",
      });
    });

    it("QR 908: DOH -> SYD, June 19 8:50 PM -> June 20 5:55 PM", () => {
      expect(segments[3]).toMatchObject({
        airlineCode: "QR",
        flightNumber: "908",
        departureAirport: "DOH",
        arrivalAirport: "SYD",
        departureDate: "2026-06-19",
        departureTime: "20:50",
        arrivalDate: "2026-06-20",
        arrivalTime: "17:55",
      });
    });
  });

  it("a standalone bare '*' (e-ticket flag) is still recognized and never becomes a warning-triggering leftover token", () => {
    const text = "1 LH400C 12MAR FRA-JFK HK1 1050A 130P * TH";
    const [seg] = parseSabreItinerary(text, 2026);
    expect(seg.warnings).toEqual([]);
  });
});
