import { describe, it, expect } from "vitest";
import { parseApolloItinerary } from "../apollo";
import { parseSabreItinerary } from "../sabre";
import { addDaysIso } from "../shared";

// Pass 23 — coverage-gap fill, not a logic change. The date-offset
// arithmetic this exercises (resolveArrivalDate/resolveDayPairOffset in
// shared.ts) is already extensively tested by date-offset.test.ts and
// next-day-arrival.test.ts, including negative offsets, month rollovers,
// and year rollovers — and shared.ts's own doc comments explicitly call
// out "international-date-line crossing" and "westbound date-line
// crossing" by name as the reason this arithmetic exists at all. What was
// missing: every existing test pins that arithmetic to a synthetic/
// non-Pacific route (JFKLAX, EWRVIE) or, in sabre.test.ts's "handles a
// year boundary across segments" case, a real transpacific SYD-LAX route
// that only asserts departureDate, never arrivalDate. Nothing tied a
// genuine trans-Pacific city pair to the arrivalDate resolution in BOTH
// directions of an International Date Line crossing:
//   - westbound (LAX->SYD): local arrival date lands a full TWO calendar
//     days after departure despite an ~14-16h flight — well short of 48h
//     elapsed — because the route also crosses the date line forward.
//   - eastbound (SYD->LAX): local arrival date can land BEFORE the local
//     departure date despite real elapsed time moving strictly forward,
//     because the ~19h timezone recovery outpaces the flight's own
//     duration. This is the "reverse" case Pass 23 asked to confirm has
//     coverage.
// Route/timing here is illustrative (matches the existing SQ22 JFK-SIN
// "ultra-long-haul crossing many time zones" test's own convention) —
// not a claim about any single airline's current published timetable.

describe("International Date Line crossings — arrivalDate resolution (Pass 23 coverage gap)", () => {
  it("westbound LAX->SYD: arrival date lands two calendar days after departure via an explicit +2 fused marker", () => {
    const [seg] = parseApolloItinerary("1 QF11Y 23NOV LAXSYD SS1 1030P 605A2", 2026);
    expect(seg.departureAirport).toBe("LAX");
    expect(seg.arrivalAirport).toBe("SYD");
    expect(seg.departureDate).toBe("2026-11-23");
    expect(seg.departureTime).toBe("22:30");
    expect(seg.arrivalTime).toBe("06:05");
    expect(seg.arrivalDate).toBe(addDaysIso(seg.departureDate!, 2));
    expect(seg.arrivalDate).toBe("2026-11-25");
    expect(seg.uncertainFields).not.toContain("arrivalDate");
  });

  it("eastbound SYD->LAX: arrival date lands BEFORE the departure date via an explicit -1 fused marker (the reverse case)", () => {
    const [seg] = parseApolloItinerary("1 QF12Y 25NOV SYDLAX SS1 355P 1145A-1", 2026);
    expect(seg.departureAirport).toBe("SYD");
    expect(seg.arrivalAirport).toBe("LAX");
    expect(seg.departureDate).toBe("2026-11-25");
    expect(seg.arrivalTime).toBe("11:45");
    expect(seg.arrivalDate).toBe(addDaysIso(seg.departureDate!, -1));
    expect(seg.arrivalDate).toBe("2026-11-24");
    // The arrival calendar date is strictly earlier than the departure
    // calendar date — the exact "reverse" shape this test exists to prove
    // the parser resolves correctly rather than clamping at same-day or
    // rejecting the input.
    expect(new Date(seg.arrivalDate!).getTime()).toBeLessThan(new Date(seg.departureDate!).getTime());
    expect(seg.uncertainFields).not.toContain("arrivalDate");
  });

  it("eastbound SYD->LAX via Sabre format with a day-of-week pair agreeing with the -1 arithmetic: same result, no disagreement warning", () => {
    // 2026-11-25 is a Wednesday and 2026-11-24 is a Tuesday — WE/TU is
    // consistent with resolveDayPairOffset's own -1 resolution for that
    // pair, so this independently confirms the day-of-week-pair path (not
    // just the fused-marker path exercised above) also resolves an IDL
    // eastbound crossing correctly.
    const [seg] = parseSabreItinerary("1 QF12Y 25NOV SYD-LAX HK1 355P 1145A * WE/TU", 2026);
    expect(seg.dayOfWeekPair).toEqual({ dep: "WE", arr: "TU" });
    expect(seg.departureDate).toBe("2026-11-25");
    expect(seg.arrivalDate).toBe("2026-11-24");
    expect(seg.warnings).toHaveLength(0);
  });

  it("westbound LAX->SYD stays a real +2 rather than the naive +1 an overnight-flight heuristic would guess, mirroring the already-tested SQ22 JFK-SIN long-haul case", () => {
    const [seg] = parseApolloItinerary("1 QF11Y 30NOV LAXSYD SS1 1030P 605A2", 2026);
    // A same-clock-reading flight landing "in the morning" after a night
    // departure looks like a simple +1 overnight — the explicit fused "2"
    // is what correctly pushes this the full two calendar days a genuine
    // westbound date-line crossing produces.
    expect(seg.arrivalDate).not.toBe(addDaysIso(seg.departureDate!, 1));
    expect(seg.arrivalDate).toBe(addDaysIso(seg.departureDate!, 2));
  });
});
