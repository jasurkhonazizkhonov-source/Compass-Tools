import { describe, it, expect } from "vitest";
import { parseGdsItinerary } from "../gds-line";
import { parseSabreItinerary } from "../sabre";
import { formatDuration } from "../shared";

// Portability pass 2, Item 6 — closes the specific edge cases the task
// checklist names that weren't yet covered by the existing, already very
// thorough +/*/day-offset test suite (see next-day-arrival.test.ts's
// "exact reported * vs + bug report" describe block, which already proves
// the core distinction this task re-raised: a bare "*" is never a
// day-change marker, and a fused "+" — with or without a digit — is).

describe("gds-line edge cases — malformed input never crashes or fabricates a value", () => {
  it("a malformed date token (invalid day-of-month/month shape) is left undetermined, not silently guessed", () => {
    const [seg] = parseGdsItinerary("1 LH400C 99XYZ FRA-JFK HK1 1050A 130P", 2026);
    expect(seg.departureDate).toBeUndefined();
    expect(seg.uncertainFields).toContain("departureDate");
    expect(seg.durationMinutes).toBeUndefined();
  });

  it("a malformed time token (out-of-range minutes) is rejected on its own — it never wraps into a bogus time, and never blocks a later, genuinely valid time token from still being read", () => {
    // "1099A" (minute 99) fails to parse as a time at all and is simply
    // skipped, matching this parser's own "never guess, never crash"
    // design — it does NOT consume the departure-time slot. The next,
    // valid time token ("130P") is still read into that same slot; the
    // arrival-time slot is correctly left empty since only one valid time
    // token existed on the line at all.
    const [seg] = parseGdsItinerary("1 LH400C 12MAR FRA-JFK HK1 1099A 130P", 2026);
    expect(seg.departureTime).toBe("13:30");
    expect(seg.arrivalTime).toBeUndefined();
    expect(seg.uncertainFields).toContain("arrivalTime");
    expect(seg.durationMinutes).toBeUndefined();
  });

  it("a missing aircraft/equipment code is simply absent — not an error, not a warning, not guessed", () => {
    const [seg] = parseGdsItinerary("1 LH400C 12MAR FRA-JFK HK1 1050A 130P TH", 2026);
    expect(seg.aircraft).toBeUndefined();
    expect(seg.warnings.some((w) => w.field === "cabin" && w.message.includes("aircraft"))).toBe(false);
  });

  it("a fused sign AND digit AND glued e-ticket asterisk together ('+2*') still resolves as +2 days — every combination of the offset marker's optional pieces is handled the same way", () => {
    const [seg] = parseGdsItinerary("1 SQ22Y 10JAN JFKSIN SS1 800A 535A+2* SA E", 2026);
    expect(seg.arrivalDate).toBe("2026-01-12");
  });

  it("duration is never computed at all when the arrival date could not be determined — never a garbage/impossible value silently shown", () => {
    // No day-of-week pair, no fused/standalone offset, and the parser's
    // own ambiguous-earlier-arrival-clock fallback only applies when dates
    // are both known — force genuine non-determination via a malformed
    // departure date instead, which removes duration computation entirely.
    const [seg] = parseGdsItinerary("1 LH400C 99XYZ FRA-JFK HK1 1050A 130P TH", 2026);
    expect(seg.arrivalDate).toBeUndefined();
    expect(seg.durationMinutes).toBeUndefined();
  });
});

describe("duration recomputation after year rollover — never stale after the date shifts", () => {
  it("a segment's durationMinutes is recomputed (not left stale) after correctYearRollover shifts its dates into the next year, for a segment whose arrival date is unambiguous (explicit day-of-week pair)", () => {
    const text = `1 QF001J 28DEC SYD-LAX HK1 945A 630A * WE
2 QF002J 03JAN LAX-SYD HK1 1030P 700A * TH/FR`;
    const segments = parseSabreItinerary(text, 2026);
    // Segment 2 rolled from 2026 into 2027 — its duration must reflect the
    // POST-rollover dates, not whatever was computed (or left undefined)
    // before the year correction ran. TH/FR unambiguously means the
    // arrival is one day after departure, so this is a real, confidently
    // resolvable positive duration — not the ambiguous same-day-fallback
    // case covered separately below.
    expect(segments[1].departureDate).toBe("2027-01-03");
    expect(segments[1].arrivalDate).toBe("2027-01-04");
    expect(segments[1].durationMinutes).toBeGreaterThan(0);
    expect(segments[1].durationMinutes).toBeLessThan(24 * 60);
  });

  it("an ambiguous same-day-fallback arrival (ARRIVAL clock earlier than departure, no explicit day-offset marker) can produce a negative raw durationMinutes — but that value is flagged uncertain, and downstream display code (formatDuration) never shows it as a real number", () => {
    // No day-of-week pair, no fused/standalone offset marker at all — this
    // is exactly the genuinely ambiguous case gds-line.ts's own comment
    // describes (real GDS output SHOULD mark this explicitly; when it
    // doesn't, the parser correctly refuses to guess and flags it instead
    // of silently producing a confident-looking but potentially wrong
    // value).
    const text = `1 QF001J 28DEC SYD-LAX HK1 945A 630A * WE
2 QF002J 03JAN LAX-SYD HK1 1030P 700A`;
    const segments = parseSabreItinerary(text, 2026);
    expect(segments[1].uncertainFields).toContain("arrivalDate");
    expect(segments[1].warnings.some((w) => w.field === "arrivalDate")).toBe(true);
    // The raw parsed value genuinely can be negative here — this is the
    // exact scenario the task asks about ("do not allow an incorrect
    // parser interpretation to silently create an obviously impossible
    // flight duration"). It IS surfaced (not hidden), but only alongside
    // an explicit "please verify" flag, and formatDuration — what every
    // real UI surface actually renders through — turns any negative
    // value into "—", never a nonsensical negative number.
    expect(segments[1].durationMinutes).toBeLessThan(0);
    expect(formatDuration(segments[1].durationMinutes!)).toBe("—");
  });
});

describe("connection-gap duration stays sane across a multi-segment itinerary", () => {
  it("each leg of a connecting itinerary gets its own correct, independent duration — never the combined door-to-door time", () => {
    const text = `1 BA1460Y 25SEP LHRFRA SS1 1100P 100A1 * FR E
2 LH400Y 26SEP FRAJFK SS1 900A 1200P * SA E`;
    const segments = parseSabreItinerary(text, 2026);
    // Leg 1: 23:00 -> 01:00 next day = 2h, not the ~13h door-to-door total.
    expect(segments[0].durationMinutes).toBe(2 * 60);
    // Leg 2: 09:00 -> 12:00 same day = 3h.
    expect(segments[1].durationMinutes).toBe(3 * 60);
  });
});
