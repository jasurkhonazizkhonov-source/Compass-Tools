import { describe, it, expect } from "vitest";
import { parseApolloItinerary } from "../apollo";
import { parseGdsTime, resolveArrivalDate, resolveDayPairOffset, getWeekdayCode } from "../shared";

describe("parseGdsTime — signed day-offset suffix (+1/+2/-1/-2)", () => {
  it("parses an explicit +1 offset with a leading sign", () => {
    expect(parseGdsTime("800A+1")).toEqual({ time: "08:00", dayOffset: 1 });
  });

  it("parses an explicit +2 offset", () => {
    expect(parseGdsTime("800A+2")).toEqual({ time: "08:00", dayOffset: 2 });
  });

  it("parses an explicit -1 offset", () => {
    expect(parseGdsTime("1100P-1")).toEqual({ time: "23:00", dayOffset: -1 });
  });

  it("parses an explicit -2 offset", () => {
    expect(parseGdsTime("800A-2")).toEqual({ time: "08:00", dayOffset: -2 });
  });

  it("still parses the unsigned form the same as before", () => {
    expect(parseGdsTime("800A1")).toEqual({ time: "08:00", dayOffset: 1 });
  });

  it("treats no suffix as no offset", () => {
    expect(parseGdsTime("800A")).toEqual({ time: "08:00", dayOffset: 0 });
  });
});

describe("resolveArrivalDate — signed offsets use real date arithmetic", () => {
  it("same day when no offset and arrival clock time is not earlier", () => {
    expect(resolveArrivalDate("2026-11-30", "17:55", "20:00", 0)).toBe("2026-11-30");
  });

  it("+1 rolls forward one day", () => {
    expect(resolveArrivalDate("2026-11-30", "17:55", "08:00", 1)).toBe("2026-12-01");
  });

  it("+2 rolls forward two days", () => {
    expect(resolveArrivalDate("2026-11-30", "17:55", "08:00", 2)).toBe("2026-12-02");
  });

  it("-1 rolls backward one day", () => {
    expect(resolveArrivalDate("2026-12-01", "23:00", "23:00", -1)).toBe("2026-11-30");
  });

  it("+1 across a month/year boundary uses real date arithmetic, not string manipulation", () => {
    expect(resolveArrivalDate("2026-12-31", "00:30", "01:00", 1)).toBe("2027-01-01");
  });
});

describe("Apollo parser — section 21 test cases", () => {
  it("parses the exact spec example: 2 UA9841 30NOV EWRVIE SS1 555P 800A+1", () => {
    const [seg] = parseApolloItinerary("2 UA9841 30NOV EWRVIE SS1 555P 800A+1 * MO/TU E", 2026);
    expect(seg.airlineCode).toBe("UA");
    expect(seg.flightNumber).toBe("9841");
    expect(seg.departureAirport).toBe("EWR");
    expect(seg.arrivalAirport).toBe("VIE");
    expect(seg.departureDate).toBe("2026-11-30");
    expect(seg.arrivalDate).toBe("2026-12-01");
    expect(seg.departureTime).toBe("17:55");
    expect(seg.arrivalTime).toBe("08:00");
    expect(seg.uncertainFields).not.toContain("arrivalDate");
    expect(seg.uncertainFields).not.toContain("arrivalTime");
    expect(seg.uncertainFields).not.toContain("departureAirport");
    expect(seg.uncertainFields).not.toContain("arrivalAirport");
  });

  it("same day: 30NOV ... arrival clock time later than departure, no offset", () => {
    const [seg] = parseApolloItinerary("1 UA9841 30NOV EWRVIE SS1 800A 1100A", 2026);
    expect(seg.departureDate).toBe("2026-11-30");
    expect(seg.arrivalDate).toBe("2026-11-30");
  });

  it("next day: 30NOV ... 800A+1", () => {
    const [seg] = parseApolloItinerary("1 UA9841 30NOV EWRVIE SS1 555P 800A+1", 2026);
    expect(seg.arrivalDate).toBe("2026-12-01");
  });

  it("two days later: 30NOV ... 800A+2", () => {
    const [seg] = parseApolloItinerary("1 UA9841 30NOV EWRVIE SS1 555P 800A+2", 2026);
    expect(seg.arrivalDate).toBe("2026-12-02");
  });

  it("previous day: 01DEC ... 1100P-1", () => {
    const [seg] = parseApolloItinerary("1 UA9841 01DEC EWRVIE SS1 300P 1100P-1", 2026);
    expect(seg.departureDate).toBe("2026-12-01");
    expect(seg.arrivalDate).toBe("2026-11-30");
  });

  it("month boundary: 31DEC ... 100A+1 rolls into January", () => {
    const [seg] = parseApolloItinerary("1 UA9841 31DEC EWRVIE SS1 1155P 100A+1", 2026);
    expect(seg.departureDate).toBe("2026-12-31");
    expect(seg.arrivalDate).toBe("2027-01-01");
  });

  it("year boundary: 31DEC 2026 ... 100A+1 -> 01JAN 2027", () => {
    const [seg] = parseApolloItinerary("1 UA9841 31DEC26 EWRVIE SS1 1155P 100A+1", 2026);
    expect(seg.departureDate).toBe("2026-12-31");
    expect(seg.arrivalDate).toBe("2027-01-01");
  });

  it("does not crash on malformed/ambiguous input and surfaces a useful warning instead", () => {
    expect(() => parseApolloItinerary("this is not a valid GDS line at all", 2026)).not.toThrow();
    const [seg] = parseApolloItinerary("1 ??? garbage 800A+1", 2026);
    expect(seg).toBeDefined();
    expect(Array.isArray(seg.warnings)).toBe(true);
  });

  it("tolerates a stray trailing comma on the route token", () => {
    const [seg] = parseApolloItinerary("1 UA9841 30NOV EWRVIE, SS1 555P 800A+1", 2026);
    expect(seg.departureAirport).toBe("EWR");
    expect(seg.arrivalAirport).toBe("VIE");
  });
});

describe("parseGdsTime — bare +/- suffix with no digit (§10/§11)", () => {
  it("a bare trailing + means exactly +1 day", () => {
    expect(parseGdsTime("1225P+")).toEqual({ time: "12:25", dayOffset: 1 });
  });

  it("a bare trailing - means exactly -1 day", () => {
    expect(parseGdsTime("1200A-")).toEqual({ time: "00:00", dayOffset: -1 });
  });

  it("tolerates a glued trailing e-ticket '*' after a bare sign (1225P+*)", () => {
    expect(parseGdsTime("1225P+*")).toEqual({ time: "12:25", dayOffset: 1 });
  });

  it("tolerates a full AM/PM suffix, not just the single-letter GDS form", () => {
    expect(parseGdsTime("1200AM-")).toEqual({ time: "00:00", dayOffset: -1 });
    expect(parseGdsTime("505AM")).toEqual({ time: "05:05", dayOffset: 0 });
  });
});

describe("resolveDayPairOffset — day-of-week pair to calendar-day offset (§9)", () => {
  it("TH/FR resolves to +1 (normal forward overnight)", () => {
    expect(resolveDayPairOffset("TH", "FR")).toBe(1);
  });

  it("TH/WE resolves to -1 (fewest-days interpretation, e.g. westbound date-line crossing)", () => {
    expect(resolveDayPairOffset("TH", "WE")).toBe(-1);
  });

  it("same code both sides resolves to 0", () => {
    expect(resolveDayPairOffset("TH", "TH")).toBe(0);
  });

  it("MO/TU resolves to +1", () => {
    expect(resolveDayPairOffset("MO", "TU")).toBe(1);
  });

  it("returns undefined for an unrecognized code", () => {
    expect(resolveDayPairOffset("TH", "XX")).toBeUndefined();
  });
});

describe("getWeekdayCode — actual weekday of an ISO date (§14 validation)", () => {
  it("2026-09-03 is a Thursday", () => {
    expect(getWeekdayCode("2026-09-03")).toBe("TH");
  });

  it("2026-09-04 is a Friday", () => {
    expect(getWeekdayCode("2026-09-04")).toBe("FR");
  });
});

describe("Apollo parser — exact spec examples (§8/§28)", () => {
  it("Example 1: 1 AA3082I 03SEP SFOCLT SS1 505A 116P * TH E — same-day arrival, single day-of-week", () => {
    const [seg] = parseApolloItinerary("1 AA3082I 03SEP SFOCLT SS1 505A 116P * TH E", 2026);
    expect(seg.airlineCode).toBe("AA");
    expect(seg.flightNumber).toBe("3082");
    expect(seg.departureAirport).toBe("SFO");
    expect(seg.arrivalAirport).toBe("CLT");
    expect(seg.departureDate).toBe("2026-09-03");
    expect(seg.departureTime).toBe("05:05");
    expect(seg.arrivalTime).toBe("13:16");
    expect(seg.arrivalDate).toBe("2026-09-03");
    expect(seg.warnings).toHaveLength(0);
  });

  it("Example 2: 2 EY 16Z 03SEP CLTAUH SS1 300P 1225P+* TH/FR E — next-day arrival, fused marker + day-pair agree", () => {
    const [seg] = parseApolloItinerary("2 EY 16Z 03SEP CLTAUH SS1 300P 1225P+* TH/FR E", 2026);
    expect(seg.departureAirport).toBe("CLT");
    expect(seg.arrivalAirport).toBe("AUH");
    expect(seg.departureDate).toBe("2026-09-03");
    expect(seg.arrivalDate).toBe("2026-09-04");
    expect(seg.departureTime).toBe("15:00");
    expect(seg.arrivalTime).toBe("12:25");
    expect(seg.dayOfWeekPair).toEqual({ dep: "TH", arr: "FR" });
    // Both the fused "+" marker and the TH/FR pair independently imply +1
    // and agree — no conflict warning.
    expect(seg.warnings).toHaveLength(0);
  });

  it("Example 3: departure 30SEP, arrival 1200AM- resolves to 29SEP (previous day)", () => {
    const [seg] = parseApolloItinerary("1 UA100 30SEP JFKLAX SS1 1100P 1200AM-", 2026);
    expect(seg.departureDate).toBe("2026-09-30");
    expect(seg.arrivalDate).toBe("2026-09-29");
  });

  it("Example 4: TH/FR alone (no fused marker) still resolves to +1", () => {
    const [seg] = parseApolloItinerary("1 UA100 03SEP JFKLAX SS1 800A 1000A * TH/FR E", 2026);
    expect(seg.arrivalDate).toBe("2026-09-04");
  });

  it("Example 5: TH/WE alone (no fused marker) resolves to -1, overriding the clock-time fallback", () => {
    // Arrival clock (01:00) is earlier than departure clock (05:05), which
    // would normally imply +1 via the plain clock heuristic — the day-pair
    // signal (-1) takes priority since it's explicitly present.
    const [seg] = parseApolloItinerary("1 UA100 03SEP JFKLAX SS1 505A 100A * TH/WE E", 2026);
    expect(seg.arrivalDate).toBe("2026-09-02");
  });

  it("a standalone +2 token (not fused to the time) is recognized and takes top priority", () => {
    const [seg] = parseApolloItinerary("1 UA100 03SEP JFKLAX SS1 505A 100A +2 TH/FR E", 2026);
    // Day-pair alone would say +1 — the standalone token (+2) is the
    // strongest signal and its value wins, though the disagreement between
    // the two signals is still surfaced as a warning per §12.
    expect(seg.arrivalDate).toBe("2026-09-05");
    expect(seg.warnings.some((w) => w.field === "arrivalDate")).toBe(true);
  });

  it("a standalone -2 token resolves two days earlier", () => {
    const [seg] = parseApolloItinerary("1 UA100 05SEP JFKLAX SS1 505A 100A -2", 2026);
    expect(seg.departureDate).toBe("2026-09-05");
    expect(seg.arrivalDate).toBe("2026-09-03");
  });

  it("conflicting signals (fused +1 marker vs. a day-pair implying +2) use the higher-priority marker and raise a warning", () => {
    // TH/SA is +2 by the smallest-magnitude rule (forward=2, backward=-5),
    // which disagrees with the fused "+1" time marker — the fused marker
    // wins (higher priority) and the disagreement is surfaced.
    const [seg] = parseApolloItinerary("1 UA100 03SEP JFKLAX SS1 505A 100P+1 TH/SA E", 2026);
    expect(seg.arrivalDate).toBe("2026-09-04"); // fused +1 wins, not day-pair's +2
    expect(seg.warnings.some((w) => w.field === "arrivalDate" && /disagree/i.test(w.message))).toBe(true);
    expect(seg.uncertainFields).toContain("arrivalDate");
  });

  it("flags a warning (without blocking) when the parsed departure date doesn't match the given day-of-week", () => {
    // 2026-09-03 is a Thursday, not a Monday — the token is wrong/stale.
    const [seg] = parseApolloItinerary("1 UA100 03SEP JFKLAX SS1 505A 100P MO E", 2026);
    expect(seg.departureDate).toBe("2026-09-03");
    expect(seg.warnings.some((w) => w.field === "departureDate" && /doesn't fall on/i.test(w.message))).toBe(true);
    // Non-blocking — the field is flagged uncertain but the date is still populated.
    expect(seg.departureDate).toBeTruthy();
  });
});
