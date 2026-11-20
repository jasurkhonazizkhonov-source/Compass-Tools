import { describe, it, expect } from "vitest";
import { businessDayKey, businessDayRange, formatBusinessTime, formatDayKey } from "../business-time";

// Business zone = America/Los_Angeles. 2026 DST: starts Sun Mar 8 (02:00 -> 03:00), ends Sun Nov 1 (02:00 -> 01:00).

describe("businessDayKey", () => {
  it("is the Los Angeles calendar day, not the UTC day", () => {
    expect(businessDayKey(new Date("2026-11-20T07:59:59Z"))).toBe("2026-11-19"); // 23:59:59 PST
    expect(businessDayKey(new Date("2026-11-20T08:00:00Z"))).toBe("2026-11-20"); // 00:00:00 PST
    expect(businessDayKey(new Date("2026-07-01T06:59:59Z"))).toBe("2026-06-30"); // PDT: midnight is 07:00 UTC
    expect(businessDayKey(new Date("2026-07-01T07:00:00Z"))).toBe("2026-07-01");
  });
});

describe("businessDayRange - DST-safe", () => {
  it("an ordinary winter day starts at 08:00 UTC and lasts 24 hours", () => {
    const { start, end } = businessDayRange("2026-11-20");
    expect(start.toISOString()).toBe("2026-11-20T08:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-21T08:00:00.000Z");
  });
  it("an ordinary summer day starts at 07:00 UTC", () => {
    expect(businessDayRange("2026-07-01").start.toISOString()).toBe("2026-07-01T07:00:00.000Z");
  });
  it("spring-forward day (2026-03-08) is 23 hours long", () => {
    const { start, end } = businessDayRange("2026-03-08");
    expect(start.toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T07:00:00.000Z");
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });
  it("fall-back day (2026-11-01) is 25 hours long", () => {
    const { start, end } = businessDayRange("2026-11-01");
    expect(start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });
  it("every instant in a range maps back to that day, and the instants just outside do not", () => {
    for (const key of ["2026-03-08", "2026-11-01", "2026-12-31", "2027-01-01", "2028-02-29"]) {
      const { start, end } = businessDayRange(key);
      expect(businessDayKey(start)).toBe(key);
      expect(businessDayKey(new Date(end.getTime() - 1))).toBe(key);
      expect(businessDayKey(new Date(start.getTime() - 1))).not.toBe(key);
      expect(businessDayKey(end)).not.toBe(key);
    }
  });
  it("rejects a malformed key", () => {
    expect(() => businessDayRange("2026-1-1")).toThrow();
    expect(() => businessDayRange("nonsense")).toThrow();
  });
});

describe("formatting", () => {
  it("shows the exact time with seconds in the business zone", () => {
    expect(formatBusinessTime(new Date("2026-11-20T17:15:12Z"))).toBe("09:15:12");
    expect(formatBusinessTime(new Date("2026-07-20T16:15:12Z"))).toBe("09:15:12");
  });
  it("labels a day key without any time-zone shift", () => {
    expect(formatDayKey("2026-11-20")).toBe("November 20, 2026");
    expect(formatDayKey("2026-01-01")).toBe("January 1, 2026");
  });
});
