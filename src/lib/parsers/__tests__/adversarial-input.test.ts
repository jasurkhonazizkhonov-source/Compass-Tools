// GDS-adversarial-input audit — proves the parsers never throw and never
// silently misbehave on hostile/malformed paste content: an oversized blob,
// HTML/script-shaped text, unusual Unicode (RTL override, zero-width,
// emoji), and duplicate segments. Every other parsed field (airline code,
// flight number, booking class, airport code, aircraft/equipment code) is
// already constrained to a narrow safe character set by its own regex in
// gds-line.ts (AIRLINE_CODE_RE/FLIGHT_ONLY_RE/AIRPORT_3_RE/EQUIPMENT_RE) —
// none of those can ever carry an HTML metacharacter through to a
// downstream consumer. The one genuinely free-text field is
// `operatingCarrierName` (verbatim text after "OPERATED BY" — see
// OPERATED_BY_RE in gds-line.ts), so that's the field these tests target
// for injection-shaped content; see
// src/server/email/__tests__/gds-adversarial-escaping.test.ts for proof
// that it's HTML-escaped before reaching an email.
import { describe, it, expect } from "vitest";
import { parseApolloItinerary } from "../apollo";
import { parseSabreItinerary } from "../sabre";
import { parseGdsItinerary, parseGdsLine } from "../gds-line";

describe("GDS parser adversarial-input safety", () => {
  it("does not throw on an extremely long single-line paste (100k chars) and returns quickly", () => {
    const huge = "A".repeat(100_000);
    const start = Date.now();
    expect(() => parseApolloItinerary(huge, 2026)).not.toThrow();
    expect(() => parseSabreItinerary(huge, 2026)).not.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("does not throw on an extremely long multi-line paste with many short tokens", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `garbage${i} !! ?? **`).join("\n");
    expect(() => parseGdsItinerary(huge, 2026)).not.toThrow();
  });

  it("does not throw on a single pathologically long token embedded in an otherwise valid line", () => {
    const line = `1 BA1460Y 25SEP LHREDI SS1 600P 725P ${"X".repeat(50_000)}`;
    expect(() => parseGdsLine(line, 1, 2026)).not.toThrow();
  });

  it("captures HTML/script-shaped content in a free-text 'OPERATED BY' line verbatim, without executing or stripping it — the parser never sanitizes; escaping is the email/UI layer's job", () => {
    const text = `1 PR2849Z 30JAN MNLCEB SS1 850A 1010A * SA E 1
        OPERATED BY <script>alert(1)</script>`;
    const [seg] = parseGdsItinerary(text, 2026);
    expect(seg.operatingCarrierName).toBe("<script>alert(1)</script>");
  });

  it("captures an <img onerror=...> payload in the operating-carrier line without throwing", () => {
    const text = `1 PR2849Z 30JAN MNLCEB SS1 850A 1010A * SA E 1
        OPERATED BY <img src=x onerror=alert(1)>`;
    expect(() => parseGdsItinerary(text, 2026)).not.toThrow();
    const [seg] = parseGdsItinerary(text, 2026);
    expect(seg.operatingCarrierName).toContain("onerror");
  });

  it("does not throw on RTL override / zero-width / emoji Unicode anywhere in the paste", () => {
    const text = `1 PR2849Z 30JAN MNLCEB SS1 850A 1010A * SA E 1
        OPERATED BY PAL‮EXPRESS​‍﻿ ✈️`;
    expect(() => parseGdsItinerary(text, 2026)).not.toThrow();
    const [seg] = parseGdsItinerary(text, 2026);
    expect(seg.operatingCarrierName).toContain("PAL");
  });

  it("does not throw when an airline/flight/date/route token itself contains stray Unicode", () => {
    const text = "1 B​A1460Y 25SEP LHREDI SS1 600P 725P";
    expect(() => parseGdsItinerary(text, 2026)).not.toThrow();
  });

  it("handles repeated/duplicate segment lines without throwing — each is parsed independently, duplicates included, exactly like any other repeated line", () => {
    const text = `1 BA1460Y 25SEP LHREDI SS1 600P 725P
2 BA1460Y 25SEP LHREDI SS1 600P 725P
3 BA1460Y 25SEP LHREDI SS1 600P 725P`;
    const segments = parseGdsItinerary(text, 2026);
    expect(segments).toHaveLength(3);
    expect(segments.every((s) => s.flightNumber === "1460")).toBe(true);
  });

  it("does not throw on malformed flight numbers, dates, and airline codes mixed into otherwise-plausible lines", () => {
    const lines = [
      "1 999999999Z 99XXX ZZZZZZ SS1 9999P 9999P",
      "1 !!##$$ 25SEP LHREDI SS1 600P 725P",
      "1 BA1460Y 32SEP LHREDI SS1 600P 725P", // invalid day-of-month
      "1 BA1460Y 25SEP LHREDI SS1 2500P 725P", // impossible time
      "",
      "   ",
      "\t\t\t",
    ];
    for (const line of lines) {
      expect(() => parseGdsLine(line, 1, 2026)).not.toThrow();
    }
  });

  it("returns an empty array (not a throw) for entirely unparseable oversized garbage", () => {
    const garbage = "☃".repeat(20_000);
    expect(() => parseGdsItinerary(garbage, 2026)).not.toThrow();
    expect(parseGdsItinerary(garbage, 2026)).toEqual([]);
  });

  // Pass 24 — re-verification with cases not already covered above or by
  // robustness.test.ts's "tolerates irregular whitespace" (regular spaces
  // only) and "flags a missing airline separately from a missing flight
  // number" (airline missing, but airports still present) tests.
  it("tolerates tab characters as token separators, same as any other whitespace", () => {
    const [seg] = parseApolloItinerary("1\tBA1460Y\t25SEP\tLHREDI\tSS1\t600P\t725P", 2026);
    expect(seg.airlineCode).toBe("BA");
    expect(seg.departureAirport).toBe("LHR");
    expect(seg.arrivalAirport).toBe("EDI");
    expect(seg.warnings).toHaveLength(0);
  });

  it("tolerates a non-breaking space (U+00A0) as a token separator — JS's \\s regex class includes it, same as a regular space", () => {
    const nbsp = " ";
    const [seg] = parseApolloItinerary(
      `1${nbsp}BA1460Y${nbsp}25SEP${nbsp}LHREDI${nbsp}SS1${nbsp}600P${nbsp}725P`,
      2026
    );
    expect(seg.airlineCode).toBe("BA");
    expect(seg.departureAirport).toBe("LHR");
    expect(seg.arrivalAirport).toBe("EDI");
    expect(seg.warnings).toHaveLength(0);
  });

  it("recovers a split city-pair token via the loose-airport fallback when extra spaces break it into two 3-letter tokens (e.g. 'LHR  EDI' instead of 'LHREDI')", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHR  EDI SS1 600P 725P", 2026);
    expect(seg.departureAirport).toBe("LHR");
    expect(seg.arrivalAirport).toBe("EDI");
    expect(seg.warnings).toHaveLength(0);
  });

  it("does NOT guess an airport pair from a single stray 3-letter token — both departure and arrival stay unset and flagged rather than assigning one blindly", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHR SS1 600P 725P", 2026);
    expect(seg.departureAirport).toBeUndefined();
    expect(seg.arrivalAirport).toBeUndefined();
    expect(seg.uncertainFields).toContain("departureAirport");
    expect(seg.uncertainFields).toContain("arrivalAirport");
  });

  it("flags both airports as undetermined when the route token is entirely absent from the line, rather than crashing or guessing", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP SS1 600P 725P", 2026);
    expect(seg.departureAirport).toBeUndefined();
    expect(seg.arrivalAirport).toBeUndefined();
    expect(seg.uncertainFields).toContain("departureAirport");
    expect(seg.uncertainFields).toContain("arrivalAirport");
    expect(seg.warnings.some((w) => w.field === "departureAirport")).toBe(true);
    expect(seg.warnings.some((w) => w.field === "arrivalAirport")).toBe(true);
  });

  it("degrades a hyphen-corrupted flight number token to an undetermined airline+flight number rather than misparsing it", () => {
    const [seg] = parseApolloItinerary("1 BA-1460Y 25SEP LHREDI SS1 600P 725P", 2026);
    expect(seg.airlineCode).toBeUndefined();
    expect(seg.flightNumber).toBeUndefined();
    expect(seg.uncertainFields).toContain("airline");
    expect(seg.uncertainFields).toContain("flightNumber");
    // The rest of the line is unaffected by the corrupted token.
    expect(seg.departureAirport).toBe("LHR");
    expect(seg.arrivalAirport).toBe("EDI");
  });

  it("degrades a punctuation-corrupted route token (a stray period splitting the city pair) to undetermined airports rather than misparsing it", () => {
    const [seg] = parseApolloItinerary("1 BA1460Y 25SEP LHR.EDI SS1 600P 725P", 2026);
    expect(seg.departureAirport).toBeUndefined();
    expect(seg.arrivalAirport).toBeUndefined();
    expect(seg.airlineCode).toBe("BA"); // unaffected fields still parse normally
  });
});
