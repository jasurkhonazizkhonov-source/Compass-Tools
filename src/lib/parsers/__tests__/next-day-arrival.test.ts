import { describe, it, expect } from "vitest";
import { parseApolloItinerary } from "../apollo";
import { parseSabreItinerary } from "../sabre";
import { parseGdsTime, parseGdsDate } from "../shared";

describe("parseGdsTime — explicit day-offset suffix", () => {
  it("parses a plain time with no offset", () => {
    expect(parseGdsTime("725P")).toEqual({ time: "19:25", dayOffset: 0 });
  });

  it("parses an explicit +1 day offset appended directly to the time", () => {
    expect(parseGdsTime("725P1")).toEqual({ time: "19:25", dayOffset: 1 });
  });

  it("parses a multi-day offset", () => {
    expect(parseGdsTime("800A2")).toEqual({ time: "08:00", dayOffset: 2 });
  });

  it("tolerates a colon in the time", () => {
    expect(parseGdsTime("7:25P")).toEqual({ time: "19:25", dayOffset: 0 });
    expect(parseGdsTime("18:30")).toEqual({ time: "18:30", dayOffset: 0 });
  });
});

describe("parseGdsDate — embedded year", () => {
  it("uses the reference year when none is embedded", () => {
    expect(parseGdsDate("25SEP", 2026)).toBe("2026-09-25");
  });

  it("uses an explicit embedded 2-digit year over the reference year", () => {
    expect(parseGdsDate("25SEP27", 2026)).toBe("2027-09-25");
  });
});

describe("Apollo/Sabre parsers — explicit day-offset arrival (section 2 example)", () => {
  it("correctly resolves a next-day arrival using the explicit offset digit, not just the clock-time heuristic", () => {
    // Departs 25SEP 23:00, arrives 26SEP 07:00 — this is the exact example
    // from the spec. The GDS line carries the day-offset digit on the
    // arrival time rather than relying on us to infer it.
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHREDI SS1 1100P 700A1 * FR E", 2026);
    expect(seg.departureDate).toBe("2026-09-25");
    expect(seg.departureTime).toBe("23:00");
    expect(seg.arrivalTime).toBe("07:00");
    expect(seg.arrivalDate).toBe("2026-09-26");
    expect(seg.uncertainFields).not.toContain("arrivalTime");
    expect(seg.uncertainFields).not.toContain("arrivalDate");
  });

  it("resolves a long-haul flight where the arrival clock time is still later in the day despite an explicit 1-day offset — the case the plain clock-time heuristic alone gets wrong", () => {
    // Departs 08:00, arrives 14:00 — a clock-time-only heuristic would say
    // "no rollover" since 14:00 > 08:00, but the explicit offset says this
    // spans a full day (a realistic shape for an ultra-long-haul crossing
    // many time zones).
    const [seg] = parseApolloItinerary("1 SQ22Y 10JAN JFKSIN SS1 800A 200P1 * SA E", 2026);
    expect(seg.departureDate).toBe("2026-01-10");
    expect(seg.arrivalTime).toBe("14:00");
    expect(seg.arrivalDate).toBe("2026-01-11");
  });

  it("stays on the same calendar day when no explicit offset marker is present, even though the arrival clock time is numerically earlier than departure — real GDS output always marks a genuine day change explicitly, so comparing raw local clock digits is never used as a fallback", () => {
    const [seg] = parseApolloItinerary("1 EK202Y 15DEC JFKDXB SS1 1130P 800A FR E", 2026);
    expect(seg.arrivalDate).toBe("2026-12-15");
    expect(seg.arrivalDate).toBe(seg.departureDate);
  });

  it("does not roll the date over for a same-day arrival with no offset digit", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHREDI SS1 600P 725P * FR E", 2026);
    expect(seg.departureDate).toBe(seg.arrivalDate);
  });

  it("handles a connecting itinerary where the first leg's next-day arrival correctly feeds the second leg's layover calculation", () => {
    const text = `1 BA1460Y 25SEP LHRFRA SS1 1100P 100A1 * FR E
2 LH400Y 26SEP FRAJFK SS1 900A 1200P * SA E`;
    const segments = parseSabreItinerary(text, 2026);
    expect(segments[0].arrivalDate).toBe("2026-09-26");
    expect(segments[0].arrivalTime).toBe("01:00");
    expect(segments[1].departureDate).toBe("2026-09-26");
  });
});

describe("Apollo parser — the exact reported * vs + bug report, MNL<->YVR", () => {
  it("case 1: bare '*' with a single unpaired day code and NO other offset marker stays on the same calendar day, even though the arrival clock (625A) is numerically earlier than departure (925A) — this is the exact reported line", () => {
    const [seg] = parseApolloItinerary("3 AC 18P 09APR MNLYVR SS1 925A 625A * FR E 2", 2026);
    expect(seg.departureDate).toBe("2026-04-09");
    expect(seg.departureTime).toBe("09:25");
    expect(seg.arrivalTime).toBe("06:25");
    expect(seg.arrivalDate).toBe("2026-04-09");
    expect(seg.arrivalDate).toBe(seg.departureDate);
  });

  it("case 2: an explicit '+' fused onto the arrival time DOES mean next-day arrival, agreeing with the TU/WE day-of-week pair — this is the exact reported line", () => {
    const [seg] = parseApolloItinerary("2 AC 17P 16MAR YVRMNL SS1 150A 645A+* TU/WE E 1", 2026);
    expect(seg.departureDate).toBe("2026-03-16");
    expect(seg.departureTime).toBe("01:50");
    expect(seg.arrivalTime).toBe("06:45");
    expect(seg.arrivalDate).toBe("2026-03-17");
  });

  it("case 3: an explicit fused digit with no sign ('535A2*') still means +2 days — untouched by this fix, the fused-marker path stays highest priority", () => {
    const [seg] = parseApolloItinerary("1 SQ22Y 10JAN JFKSIN SS1 800A 535A2* SA E", 2026);
    expect(seg.arrivalDate).toBe("2026-01-12");
  });

  it("case 4: a second, distinct city pair confirms this isn't specific to one route — arrival numerically earlier than departure, no explicit marker, stays same-day per source data", () => {
    const [seg] = parseApolloItinerary("1 NZ2Y 12JUN AKLLAX SS1 1140P 245P * FR E", 2026);
    expect(seg.arrivalDate).toBe(seg.departureDate);
  });

  it("case 5: no fused digit, but a day-of-week pair genuinely implying next-day arrival still correctly rolls the date over", () => {
    const [seg] = parseApolloItinerary("1 QF12Y 20JUL LAXSYD SS1 1030P 700A * TH/SA E", 2026);
    expect(seg.arrivalDate).not.toBe(seg.departureDate);
  });

  it("case 6: a multi-segment itinerary mixing one genuinely same-day leg and one genuinely next-day leg resolves each independently and correctly", () => {
    const text = `1 AC18P 09APR MNLYVR SS1 925A 625A * FR E
2 AC17P 16MAR YVRMNL SS1 150A 645A+* TU/WE E`;
    const segments = parseApolloItinerary(text, 2026);
    expect(segments[0].arrivalDate).toBe(segments[0].departureDate);
    expect(segments[1].arrivalDate).not.toBe(segments[1].departureDate);
  });

  it("case 7: a previously-supported, unrelated same-day format keeps working unchanged (regression guard)", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHREDI SS1 600P 725P * FR E", 2026);
    expect(seg.departureDate).toBe(seg.arrivalDate);
  });
});

describe("Apollo/Sabre parsers — cabin/booking-class confirmation only when genuinely uncertain", () => {
  it("does not ask to confirm cabin or booking class across a range of recognized RBDs", () => {
    const cases: Array<[string, string]> = [
      ["1 BA100F 10JAN LHRJFK SS1 800A 1100A", "FIRST"],
      ["1 BA100J 10JAN LHRJFK SS1 800A 1100A", "BUSINESS"],
      ["1 BA100W 10JAN LHRJFK SS1 800A 1100A", "PREMIUM_ECONOMY"],
      ["1 BA100Y 10JAN LHRJFK SS1 800A 1100A", "ECONOMY"],
    ];
    for (const [line, expectedCabin] of cases) {
      const [seg] = parseApolloItinerary(line, 2026);
      expect(seg.cabinGuess).toBe(expectedCabin);
      expect(seg.uncertainFields).not.toContain("cabin");
      expect(seg.uncertainFields).not.toContain("bookingClass");
    }
  });

  it("still asks to confirm cabin when booking class is absent entirely", () => {
    const [seg] = parseApolloItinerary("1 BA100 10JAN LHRJFK SS1 800A 1100A", 2026);
    expect(seg.bookingClass).toBeUndefined();
    expect(seg.uncertainFields).toContain("cabin");
  });
});

describe("Apollo/Sabre parsers — additional realistic robustness", () => {
  it("handles a direct flight with no connection and no ambiguity", () => {
    const [seg] = parseApolloItinerary("1 DL100Y 05MAY JFKLAX SS1 900A 1200P", 2026);
    expect(seg.departureAirport).toBe("JFK");
    expect(seg.arrivalAirport).toBe("LAX");
    expect(seg.warnings).toHaveLength(0);
  });

  it("handles a multi-city itinerary with one overnight leg among direct legs", () => {
    const text = `1 AA100Y 10JAN JFKLAX SS1 800A 1130A
2 AA200Y 12JAN LAXHNL SS1 1000P 100A1
3 AA300Y 20JAN HNLJFK SS1 500P 900A1`;
    const segments = parseApolloItinerary(text, 2026);
    expect(segments).toHaveLength(3);
    expect(segments[1].arrivalDate).toBe("2026-01-13");
    expect(segments[2].arrivalDate).toBe("2026-01-21");
  });

  it("handles a date token with an embedded year across a segment", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP27 LHREDI SS1 600P 725P", 2026);
    expect(seg.departureDate).toBe("2027-09-25");
  });
});
