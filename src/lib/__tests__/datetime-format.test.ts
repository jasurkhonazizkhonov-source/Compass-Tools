import { describe, it, expect } from "vitest";
import { formatShortTimestamp } from "../datetime-format";

describe("formatShortTimestamp — shared Bookings/Quotes list timestamp formatter", () => {
  it("renders month abbreviation, day, hour:minute, AM/PM — no seconds, no year", () => {
    const d = new Date(2026, 7, 17, 13, 24, 9); // Aug 17, 2026, 1:24:09 PM local
    expect(formatShortTimestamp(d)).toBe("Aug 17, 1:24 PM");
  });

  it("pads no leading zero on the hour and uses AM for morning times", () => {
    const d = new Date(2026, 0, 5, 9, 5, 0); // Jan 5, 9:05 AM
    expect(formatShortTimestamp(d)).toBe("Jan 5, 9:05 AM");
  });

  it("renders midnight as 12:00 AM and noon as 12:00 PM", () => {
    expect(formatShortTimestamp(new Date(2026, 2, 1, 0, 0, 0))).toBe("Mar 1, 12:00 AM");
    expect(formatShortTimestamp(new Date(2026, 2, 1, 12, 0, 0))).toBe("Mar 1, 12:00 PM");
  });

  it("never includes a year or relative-time wording", () => {
    const result = formatShortTimestamp(new Date(2026, 7, 17, 13, 24, 0));
    expect(result).not.toMatch(/2026/);
    expect(result).not.toMatch(/ago|minute|hour|day/i);
  });
});
