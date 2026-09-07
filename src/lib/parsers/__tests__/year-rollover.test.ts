import { describe, it, expect } from "vitest";
import { parseGdsItinerary } from "../gds-line";
import { parseApolloItinerary } from "../apollo";
import { parseSabreItinerary } from "../sabre";

// The "today"-relative rollover is entirely opt-in (see gds-line.ts's
// rollForwardIfEntirelyPast) — every test below passes a FIXED `today`
// rather than the real clock, so these stay deterministic regardless of
// when the suite actually runs. referenceYear is left at its explicit
// value in every case, matching every other existing parser test's
// convention, so this file only ever exercises the new opt-in behavior.

describe("year rollover relative to today", () => {
  it("rolls a past-this-year date forward to next year when today is provided", () => {
    const text = "1 BA1460Y 25JUN LHREDI SS1 600P 725P";
    const today = new Date(2026, 7, 22); // August 22, 2026 — June has already passed
    const [seg] = parseGdsItinerary(text, 2026, today);
    expect(seg.departureDate).toBe("2027-06-25");
  });

  it("leaves a still-upcoming-this-year date alone", () => {
    const text = "1 BA1460Y 25DEC LHREDI SS1 600P 725P";
    const today = new Date(2026, 7, 22); // August 22, 2026 — December hasn't happened yet
    const [seg] = parseGdsItinerary(text, 2026, today);
    expect(seg.departureDate).toBe("2026-12-25");
  });

  it("does nothing at all when today is omitted — matches every existing test's expectation", () => {
    const text = "1 BA1460Y 25JUN LHREDI SS1 600P 725P";
    const [seg] = parseGdsItinerary(text, 2026);
    expect(seg.departureDate).toBe("2026-06-25"); // stays in the "past" — no today, no correction
  });

  it("never overrides an explicitly embedded 2-digit year, even if that date is in the past relative to today", () => {
    const text = "1 BA1460Y 25JUN26 LHREDI SS1 600P 725P";
    const today = new Date(2026, 7, 22);
    const [seg] = parseGdsItinerary(text, 2026, today);
    expect(seg.departureDate).toBe("2026-06-25"); // explicit "26" honored verbatim
  });

  it("rolls the WHOLE itinerary forward together when the earliest segment is past-this-year, preserving segment order", () => {
    const text = `1 UA905Y 05JUN ORD-LHR HK1 615P 800A * SA
2 UA906Y 20JUN LHR-ORD HK1 1145A 230P FR`;
    const today = new Date(2026, 7, 22);
    const segments = parseSabreItinerary(text, 2026, today);
    expect(segments[0].departureDate).toBe("2027-06-05");
    expect(segments[1].departureDate).toBe("2027-06-20");
  });

  it("still applies the existing cross-segment year-boundary correction on top of a rolled-forward itinerary", () => {
    const text = `1 QF001J 28DEC SYD-LAX HK1 945A 630A * WE
2 QF002J 03JAN LAX-SYD HK1 1030P 700A * FR`;
    // Both are past-this-year relative to today, so the whole itinerary
    // rolls to 2027/2028 first, then the existing boundary-crossing logic
    // still correctly pushes segment 2 into the following year.
    const today = new Date(2027, 1, 1); // Feb 1, 2027 — both Dec 2026 and Jan 2027 have passed
    const segments = parseSabreItinerary(text, 2026, today);
    expect(segments[0].departureDate).toBe("2027-12-28");
    expect(segments[1].departureDate).toBe("2028-01-03");
  });

  it("works identically through the Apollo entry point", () => {
    const text = "1 BA1460Y 25JUN LHREDI SS1 600P 725P";
    const today = new Date(2026, 7, 22);
    const [seg] = parseApolloItinerary(text, 2026, today);
    expect(seg.departureDate).toBe("2027-06-25");
  });

  it("a date exactly today is not treated as past", () => {
    const text = "1 BA1460Y 22AUG LHREDI SS1 600P 725P";
    const today = new Date(2026, 7, 22); // August 22, 2026
    const [seg] = parseGdsItinerary(text, 2026, today);
    expect(seg.departureDate).toBe("2026-08-22");
  });
});
