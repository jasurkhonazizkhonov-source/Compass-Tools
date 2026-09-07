import { describe, it, expect } from "vitest";
import { toAirportDateTime, parseAirportDateTimeString, formatAirportDate, formatAirportTime, formatAirportDateTime } from "../airport-datetime";

describe("toAirportDateTime / parseAirportDateTimeString — write-path interpretation", () => {
  it("stores the given wall-clock numbers in the Date's UTC fields, not local ones", () => {
    const d = toAirportDateTime("2026-08-27", "14:09");
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(7); // 0-indexed: August
    expect(d.getUTCDate()).toBe(27);
    expect(d.getUTCHours()).toBe(14);
    expect(d.getUTCMinutes()).toBe(9);
  });

  it("parseAirportDateTimeString produces the identical Date as toAirportDateTime for the same wall-clock values", () => {
    const combined = parseAirportDateTimeString("2026-08-27T14:09:00");
    const separate = toAirportDateTime("2026-08-27", "14:09");
    expect(combined.getTime()).toBe(separate.getTime());
  });

  it("parseAirportDateTimeString is idempotent — a string that already ends in Z is not double-suffixed", () => {
    const withZ = parseAirportDateTimeString("2026-08-27T14:09:00Z");
    const withoutZ = parseAirportDateTimeString("2026-08-27T14:09:00");
    expect(withZ.getTime()).toBe(withoutZ.getTime());
  });

  it("the interpretation is independent of the wall-clock hour value — no accidental AM/PM or 24h confusion", () => {
    expect(toAirportDateTime("2026-01-01", "00:00").getUTCHours()).toBe(0);
    expect(toAirportDateTime("2026-01-01", "23:59").getUTCHours()).toBe(23);
  });
});

describe("formatAirportDate / formatAirportTime — display-path interpretation", () => {
  it("formats the UTC fields, reconstructing the exact original wall-clock values", () => {
    const d = toAirportDateTime("2026-08-27", "14:09");
    expect(formatAirportTime(d)).toBe("2:09 PM");
    expect(formatAirportDate(d)).toBe("Thu, Aug 27");
  });

  it("handles midnight and noon correctly", () => {
    expect(formatAirportTime(toAirportDateTime("2026-01-01", "00:00"))).toBe("12:00 AM");
    expect(formatAirportTime(toAirportDateTime("2026-01-01", "12:00"))).toBe("12:00 PM");
  });

  it("formatAirportDateTime combines both", () => {
    const d = toAirportDateTime("2026-08-27", "14:09");
    expect(formatAirportDateTime(d)).toBe("Thu, Aug 27, 2:09 PM");
  });
});

describe("full round-trip regression — exact itinerary from the reported bug", () => {
  // The itinerary given in the spec report. Every leg must round-trip
  // through toAirportDateTime -> formatAirportDate/Time back to the exact
  // originally-entered values — this is the write path (quotes.ts) and the
  // shared display path (flight-itinerary-display.tsx AND templates.ts,
  // which both now call these exact same functions) exercised together.
  const legs: Array<{ route: string; depDate: string; depTime: string; depExpected: string; arrDate: string; arrTime: string; arrExpected: string }> = [
    { route: "MCO -> PHL", depDate: "2026-08-27", depTime: "14:09", depExpected: "2:09 PM", arrDate: "2026-08-27", arrTime: "16:47", arrExpected: "4:47 PM" },
    { route: "PHL -> DOH", depDate: "2026-08-27", depTime: "21:30", depExpected: "9:30 PM", arrDate: "2026-08-28", arrTime: "17:25", arrExpected: "5:25 PM" },
    { route: "DOH -> NBO", depDate: "2026-08-28", depTime: "18:45", depExpected: "6:45 PM", arrDate: "2026-08-28", arrTime: "23:50", arrExpected: "11:50 PM" },
    { route: "NBO -> DOH", depDate: "2026-09-05", depTime: "01:20", depExpected: "1:20 AM", arrDate: "2026-09-05", arrTime: "06:25", arrExpected: "6:25 AM" },
    { route: "DOH -> MIA", depDate: "2026-09-05", depTime: "08:25", depExpected: "8:25 AM", arrDate: "2026-09-05", arrTime: "16:40", arrExpected: "4:40 PM" },
    { route: "MIA -> MCO", depDate: "2026-09-05", depTime: "19:40", depExpected: "7:40 PM", arrDate: "2026-09-05", arrTime: "21:03", arrExpected: "9:03 PM" },
  ];

  for (const leg of legs) {
    it(`${leg.route}: departure ${leg.depExpected}, arrival ${leg.arrExpected}`, () => {
      const departureAt = toAirportDateTime(leg.depDate, leg.depTime);
      const arrivalAt = toAirportDateTime(leg.arrDate, leg.arrTime);
      expect(formatAirportTime(departureAt)).toBe(leg.depExpected);
      expect(formatAirportTime(arrivalAt)).toBe(leg.arrExpected);
    });
  }

  it("the client write-path string format (naive, no offset) round-trips identically to the direct-parts construction", () => {
    for (const leg of legs) {
      const viaClientString = parseAirportDateTimeString(`${leg.depDate}T${leg.depTime}:00`);
      const viaDirectParts = toAirportDateTime(leg.depDate, leg.depTime);
      expect(viaClientString.getTime()).toBe(viaDirectParts.getTime());
      expect(formatAirportTime(viaClientString)).toBe(leg.depExpected);
    }
  });
});

// The behavioral proof that the email renderer and the CRM/View-Deal/
// booking-page renderer can never drift apart again lives in
// src/server/email/__tests__/templates.test.ts's "itinerary time
// regression" suite, which renders a real email through buildQuoteEmail()
// and asserts on the literal HTML output — this file covers the shared
// utility functions themselves.
