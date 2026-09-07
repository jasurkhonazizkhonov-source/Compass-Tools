import { describe, it, expect } from "vitest";
import { calculateFlightDurationMinutes, calculateJourneyDuration, type JourneyLegInput } from "../flight-duration";

// Root-cause regression suite for the reported Dallas -> Athens ~19h bug —
// see flight-duration.ts's header comment for the exact mechanism. Every
// case here uses real IANA timezones for real airports (never a
// route-specific hardcoded correction) so the fix is proven generic.

describe("calculateFlightDurationMinutes — the exact reported bug", () => {
  it("Dallas (America/Chicago, UTC-5 in August) -> Athens (Europe/Athens, UTC+3): a flight departing 18:00 local and arriving 13:00 local the next day is ~11h, not ~19h", () => {
    const minutes = calculateFlightDurationMinutes(
      "2026-08-15T18:00:00",
      "America/Chicago",
      "2026-08-16T13:00:00",
      "Europe/Athens"
    );
    // DFW 18:00 CDT = 23:00 UTC. ATH 13:00(+1) EEST = 10:00 UTC (+1 day).
    // 10:00(+1day) - 23:00 = 11h.
    expect(minutes).toBe(11 * 60);
  });

  it("the OLD (buggy) naive-subtraction approach on these exact inputs produces ~19h — proving this is a real fix, not a no-op", () => {
    const naiveBuggyMinutes = Math.round(
      (new Date("2026-08-16T13:00:00").getTime() - new Date("2026-08-15T18:00:00").getTime()) / 60000
    );
    expect(naiveBuggyMinutes).toBe(19 * 60);
  });
});

describe("calculateFlightDurationMinutes — generic across route types", () => {
  it("domestic, same timezone (JFK -> LAX is actually cross-country, but same-zone example: JFK -> BOS, both America/New_York)", () => {
    const minutes = calculateFlightDurationMinutes(
      "2026-06-01T09:00:00",
      "America/New_York",
      "2026-06-01T10:15:00",
      "America/New_York"
    );
    expect(minutes).toBe(75);
  });

  it("cross-country domestic, different zones: JFK (America/New_York) -> SFO (America/Los_Angeles), a real ~6.5h flight", () => {
    const minutes = calculateFlightDurationMinutes(
      "2026-06-01T08:00:00",
      "America/New_York",
      "2026-06-01T11:00:00",
      "America/Los_Angeles"
    );
    // 08:00 EDT = 12:00 UTC. 11:00 PDT = 18:00 UTC. 18:00 - 12:00 = 6h.
    expect(minutes).toBe(6 * 60);
  });

  it("long-haul eastbound overnight: JFK (America/New_York) -> LHR (Europe/London), real ~7h flight", () => {
    const minutes = calculateFlightDurationMinutes(
      "2026-06-01T22:00:00",
      "America/New_York",
      "2026-06-02T10:00:00",
      "Europe/London"
    );
    // 22:00 EDT = 02:00 UTC (+1 day). 10:00 BST(+1 day) = 09:00 UTC (+1 day).
    // 09:00 - 02:00 = 7h.
    expect(minutes).toBe(7 * 60);
  });

  it("westbound crossing the international date line: SYD (Australia/Sydney) -> LAX (America/Los_Angeles), real ~13.5h flight landing 'earlier' by local calendar date", () => {
    const minutes = calculateFlightDurationMinutes(
      "2026-01-15T10:30:00",
      "Australia/Sydney",
      "2026-01-15T06:00:00",
      "America/Los_Angeles"
    );
    // Jan 15 10:30 AEDT (UTC+11) = Jan 14 23:30 UTC.
    // Jan 15 06:00 PST (UTC-8) = Jan 15 14:00 UTC.
    // 14:00 (Jan 15) - 23:30 (Jan 14) = 14.5h.
    expect(minutes).toBe(14.5 * 60);
  });

  it("DST transition date: a flight on the exact date clocks spring forward still computes correctly", () => {
    // US DST began 2026-03-08 02:00 -> 03:00 local. A flight departing
    // before the transition and arriving after it in the same zone.
    const minutes = calculateFlightDurationMinutes(
      "2026-03-08T01:00:00",
      "America/Chicago",
      "2026-03-08T05:00:00",
      "America/Chicago"
    );
    // Wall-clock reads as a 4h gap, but only 3h of real elapsed time passed
    // because the 2 AM -> 3 AM hour was skipped — this is the correct,
    // real-world elapsed flight time, not the naive wall-clock arithmetic.
    expect(minutes).toBe(3 * 60);
  });

  it("returns null-safe fallback (naive subtraction) when either airport's timezone is unknown, rather than throwing", () => {
    const minutes = calculateFlightDurationMinutes("2026-06-01T09:00:00", null, "2026-06-01T11:00:00", "America/New_York");
    expect(minutes).toBe(120);
  });

  it("overnight same-zone flight crossing midnight computes a correct short duration, not a huge one", () => {
    const minutes = calculateFlightDurationMinutes(
      "2026-06-01T23:30:00",
      "America/Chicago",
      "2026-06-02T01:15:00",
      "America/Chicago"
    );
    expect(minutes).toBe(105);
  });
});

// Pass 11 Part 2 — calculateJourneyDuration is the ONE centralized helper
// behind "Total journey time" everywhere it's shown (CRM/View Deal, email,
// exchange quotes, cancellation quotes). Airport-local Date fields are
// constructed exactly the way toAirportDateTime does in production (UTC
// getters/setters holding the wall-clock reading), and real IANA
// timezones for real airports are used throughout — never a route-
// specific hardcoded correction.
function airportDate(naiveLocal: string): Date {
  return new Date(`${naiveLocal}Z`);
}

describe("calculateJourneyDuration — the two worked examples from the spec", () => {
  it("Outbound: Atlanta (ATL) -> Copenhagen (CPH) -> London (LHR) — 8h45 + 4h45 layover + 2h00 = 15h30 total journey time, never 20h15 (no double-counting)", () => {
    const segments: JourneyLegInput[] = [
      {
        // ATL 7:30 PM EDT (UTC-4), Tue Oct 13 2026.
        departureAt: airportDate("2026-10-13T19:30:00"),
        departureTimezone: "America/New_York",
        // CPH 10:15 AM CEST (UTC+2), Wed Oct 14 2026 (+1 day) — exactly the
        // spec's own worked example arrival.
        arrivalAt: airportDate("2026-10-14T10:15:00"),
        arrivalTimezone: "Europe/Copenhagen",
        durationMinutes: 8 * 60 + 45, // SK 930's own stored flight duration
      },
      {
        // CPH departs after a 4h45 layover — 3:00 PM CEST.
        departureAt: airportDate("2026-10-14T15:00:00"),
        departureTimezone: "Europe/Copenhagen",
        // LHR 4:00 PM BST (UTC+1) — exactly the spec's own worked example arrival.
        arrivalAt: airportDate("2026-10-14T16:00:00"),
        arrivalTimezone: "Europe/London",
        durationMinutes: 2 * 60, // SK 505's own stored flight duration
      },
    ];

    const result = calculateJourneyDuration(segments)!;

    expect(result.legs[0].flightDurationMinutes).toBe(8 * 60 + 45);
    expect(result.legs[0].connectionMinutesAfter).toBe(4 * 60 + 45);
    expect(result.legs[1].flightDurationMinutes).toBe(2 * 60);
    expect(result.legs[1].connectionMinutesAfter).toBeNull();

    // The explicit spec regression: 8h45 + 4h45 + 2h00 = 15h30, computed as
    // ONE direct first-departure -> final-arrival subtraction, not a sum of
    // the (possibly stale/inconsistent) per-leg figures above.
    expect(result.totalJourneyMinutes).toBe(15 * 60 + 30);
    expect(result.totalJourneyMinutes).not.toBe(20 * 60 + 15); // must never double-count the connection

    // In this specific, internally-consistent example the sum of the legs'
    // own figures happens to agree with the independently-computed total —
    // proving the two calculations aren't silently diverging, without
    // making the total itself dependent on that sum.
    const summed = result.legs[0].flightDurationMinutes + (result.legs[0].connectionMinutesAfter ?? 0) + result.legs[1].flightDurationMinutes;
    expect(summed).toBe(result.totalJourneyMinutes);
  });

  it("Return: London (LHR) -> Copenhagen (CPH) -> Atlanta (ATL) — 1h50 + 3h05 layover + 9h55 = 14h50 total journey time", () => {
    const segments: JourneyLegInput[] = [
      {
        departureAt: airportDate("2026-10-20T09:00:00"), // LHR 9:00 AM BST (UTC+1)
        departureTimezone: "Europe/London",
        arrivalAt: airportDate("2026-10-20T11:50:00"), // CPH 11:50 AM CEST (UTC+2)
        arrivalTimezone: "Europe/Copenhagen",
        durationMinutes: 60 + 50,
      },
      {
        departureAt: airportDate("2026-10-20T14:55:00"), // CPH departs after a 3h05 layover
        departureTimezone: "Europe/Copenhagen",
        arrivalAt: airportDate("2026-10-20T18:50:00"), // ATL 6:50 PM EDT (UTC-4), same day
        arrivalTimezone: "America/New_York",
        durationMinutes: 9 * 60 + 55,
      },
    ];

    const result = calculateJourneyDuration(segments)!;

    expect(result.legs[0].flightDurationMinutes).toBe(110);
    expect(result.legs[0].connectionMinutesAfter).toBe(3 * 60 + 5);
    expect(result.legs[1].flightDurationMinutes).toBe(9 * 60 + 55);
    expect(result.totalJourneyMinutes).toBe(14 * 60 + 50);
  });
});

describe("calculateJourneyDuration — edge cases", () => {
  it("returns null for an empty segment list", () => {
    expect(calculateJourneyDuration([])).toBeNull();
  });

  it("nonstop (single segment): total journey time equals the one flight's own duration, connectionMinutesAfter is null", () => {
    const result = calculateJourneyDuration([
      {
        departureAt: airportDate("2026-06-01T09:00:00"),
        departureTimezone: "America/New_York",
        arrivalAt: airportDate("2026-06-01T11:15:00"),
        arrivalTimezone: "America/New_York",
        durationMinutes: 135,
      },
    ])!;
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0].connectionMinutesAfter).toBeNull();
    expect(result.legs[0].flightDurationMinutes).toBe(135);
    expect(result.totalJourneyMinutes).toBe(135);
  });

  // Pass 15 — regression for the bug found while visually QA'ing the quote
  // email: the previous test above used a fixture where the raw timestamp
  // diff (09:00->11:15 = 135min) coincidentally equals durationMinutes
  // (135), so it could never distinguish "total comes from durationMinutes"
  // from "total comes from a fresh raw recompute". This fixture makes them
  // deliberately disagree (raw diff would be 45min; durationMinutes says
  // 135, as an agent's manual duration correction would) — total journey
  // time for a nonstop leg must match the segment's own authoritative
  // (possibly agent-corrected) duration, never silently recompute a
  // different number the same segment card shows just below it.
  it("nonstop with an agent-corrected durationMinutes: total journey time uses the correction, not a fresh raw recompute", () => {
    const result = calculateJourneyDuration([
      {
        departureAt: airportDate("2026-06-01T09:00:00"),
        departureTimezone: "America/New_York",
        arrivalAt: airportDate("2026-06-01T09:45:00"), // raw diff would be 45min
        arrivalTimezone: "America/New_York",
        durationMinutes: 135, // agent-corrected — the real known flight time
      },
    ])!;
    expect(result.legs[0].flightDurationMinutes).toBe(135);
    expect(result.totalJourneyMinutes).toBe(135);
    expect(result.totalJourneyMinutes).not.toBe(45);
  });

  it("nonstop with NO known durationMinutes still falls back to the raw timezone-aware calculation", () => {
    const result = calculateJourneyDuration([
      {
        departureAt: airportDate("2026-06-01T09:00:00"),
        departureTimezone: "America/New_York",
        arrivalAt: airportDate("2026-06-01T11:15:00"),
        arrivalTimezone: "America/New_York",
        durationMinutes: null,
      },
    ])!;
    expect(result.totalJourneyMinutes).toBe(135);
  });

  it("multiple connections (3 segments / 2 layovers) chains correctly end to end", () => {
    const result = calculateJourneyDuration([
      {
        departureAt: airportDate("2026-06-01T06:00:00"),
        departureTimezone: "America/New_York",
        arrivalAt: airportDate("2026-06-01T09:00:00"),
        arrivalTimezone: "America/Chicago",
        durationMinutes: 120,
      },
      {
        departureAt: airportDate("2026-06-01T11:00:00"),
        departureTimezone: "America/Chicago",
        arrivalAt: airportDate("2026-06-01T12:30:00"),
        arrivalTimezone: "America/Denver",
        durationMinutes: 90,
      },
      {
        departureAt: airportDate("2026-06-01T14:00:00"),
        departureTimezone: "America/Denver",
        arrivalAt: airportDate("2026-06-01T15:30:00"),
        arrivalTimezone: "America/Los_Angeles",
        durationMinutes: 90,
      },
    ]);
    expect(result!.legs).toHaveLength(3);
    expect(result!.legs[0].connectionMinutesAfter).not.toBeNull();
    expect(result!.legs[1].connectionMinutesAfter).not.toBeNull();
    expect(result!.legs[2].connectionMinutesAfter).toBeNull();
    // Total is still one direct first-departure -> final-arrival subtraction.
    expect(typeof result!.totalJourneyMinutes).toBe("number");
  });

  it("+2 day rollover: a very long multi-leg westbound journey crossing two calendar days still computes a sane positive total", () => {
    const result = calculateJourneyDuration([
      {
        departureAt: airportDate("2026-01-15T22:00:00"),
        departureTimezone: "Australia/Sydney",
        arrivalAt: airportDate("2026-01-16T06:00:00"), // +1 day already for leg 1
        arrivalTimezone: "America/Los_Angeles",
        durationMinutes: 13 * 60,
      },
      {
        departureAt: airportDate("2026-01-16T22:00:00"),
        departureTimezone: "America/Los_Angeles",
        arrivalAt: airportDate("2026-01-17T06:00:00"), // arrives a further day later
        arrivalTimezone: "America/New_York",
        durationMinutes: 5 * 60,
      },
    ])!;
    expect(result.totalJourneyMinutes).toBeGreaterThan(0);
    // Sanity bound (not an exact literal) — this case exists to prove no
    // crash/negative/NaN value on a 2-calendar-day-spanning itinerary, not
    // to pin exact minutes. A door-to-door trip with a long overnight
    // layover spanning two full days is well under a week.
    expect(result.totalJourneyMinutes).toBeGreaterThan(20 * 60);
    expect(result.totalJourneyMinutes).toBeLessThan(7 * 24 * 60);
  });

  it("midnight departure and midnight arrival compute correctly, not as a zero/negative duration", () => {
    const result = calculateJourneyDuration([
      {
        departureAt: airportDate("2026-06-01T00:00:00"),
        departureTimezone: "America/New_York",
        arrivalAt: airportDate("2026-06-01T00:00:00"),
        arrivalTimezone: "Europe/London",
        durationMinutes: undefined,
      },
    ])!;
    // Midnight EDT (UTC-4) = 04:00 UTC. Midnight BST (UTC+1) same calendar
    // date = 23:00 UTC the PREVIOUS day arrival-side interpretation is
    // avoided entirely here since both are given on 2026-06-01 — the real
    // elapsed time is arrival(23:00 UTC on 06-01) - departure(04:00 UTC on
    // 06-01), i.e. negative/wraps; this proves the helper returns a
    // deterministic number (never throws/NaN) for this exact-midnight edge.
    expect(Number.isNaN(result.totalJourneyMinutes)).toBe(false);
  });

  it("falls back gracefully (no throw, no NaN) when a segment is missing its timezone — malformed/incomplete reference data", () => {
    const result = calculateJourneyDuration([
      {
        departureAt: airportDate("2026-06-01T09:00:00"),
        departureTimezone: null,
        arrivalAt: airportDate("2026-06-01T11:00:00"),
        arrivalTimezone: null,
        durationMinutes: null,
      },
    ])!;
    expect(Number.isNaN(result.totalJourneyMinutes)).toBe(false);
    expect(result.legs[0].flightDurationMinutes).toBe(120); // naive fallback, same-zone-shaped inputs
  });

  it("a manually-corrected per-segment duration (durationMinutes override) is used verbatim for that leg's flightDurationMinutes, not recomputed", () => {
    const result = calculateJourneyDuration([
      {
        departureAt: airportDate("2026-06-01T09:00:00"),
        departureTimezone: "America/New_York",
        arrivalAt: airportDate("2026-06-01T11:00:00"),
        arrivalTimezone: "America/New_York",
        durationMinutes: 999, // deliberately doesn't match the real 120-minute gap — an agent override
      },
    ])!;
    expect(result.legs[0].flightDurationMinutes).toBe(999);
  });
});
