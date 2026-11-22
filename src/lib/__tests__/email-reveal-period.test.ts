import { describe, it, expect } from "vitest";
import { REVEAL_RESET_LABEL, emailRevealPeriod } from "../business-time";

// The customer-email reveal period: 13:15 to 13:15 in America/Los_Angeles, as a WALL-CLOCK time (so daylight saving moves the UTC instant, never the local time).
// Pure arithmetic with explicit instants - no real clock is waited for.

const at = (iso: string) => emailRevealPeriod(new Date(iso));
const iso = (d: Date) => d.toISOString();

describe("emailRevealPeriod - the 1:15 PM Pacific boundary", () => {
  it("the label people see names the reset time", () => {
    expect(REVEAL_RESET_LABEL).toBe("1:15 PM Pacific time");
  });

  it("winter (PST, UTC-8): 13:14:59 still belongs to the period that began the day before; 13:15:00 starts a new one", () => {
    expect(at("2026-11-21T21:14:59Z").key).toBe("p20261120"); // 13:14:59 PST on Nov 21
    expect(at("2026-11-21T21:15:00Z").key).toBe("p20261121"); // 13:15:00 PST on Nov 21
    expect(iso(at("2026-11-21T21:15:00Z").startsAt)).toBe("2026-11-21T21:15:00.000Z");
    expect(iso(at("2026-11-21T21:15:00Z").endsAt)).toBe("2026-11-22T21:15:00.000Z");
  });

  it("summer (PDT, UTC-7): the same wall-clock time is one hour earlier in UTC - no permanent UTC offset is used", () => {
    expect(at("2026-07-10T20:14:59Z").key).toBe("p20260709"); // 13:14:59 PDT on Jul 10
    expect(at("2026-07-10T20:15:00Z").key).toBe("p20260710");
    expect(iso(at("2026-07-10T20:15:00Z").endsAt)).toBe("2026-07-11T20:15:00.000Z");
  });

  it("midnight - Pacific or UTC - is NOT a boundary any more", () => {
    // 00:00 PST Nov 21 (08:00Z) and 00:00 UTC Nov 21 are both inside the period that began Nov 20 at 13:15.
    expect(at("2026-11-21T08:00:00Z").key).toBe("p20261120");
    expect(at("2026-11-21T00:00:00Z").key).toBe("p20261120");
    expect(at("2026-11-21T08:00:00Z").key).toBe(at("2026-11-21T21:14:59Z").key);
  });

  it("a period is a full cycle: every instant inside it has the same key, and endsAt is exactly where the next one begins", () => {
    const p = at("2026-11-21T09:00:00Z");
    expect(p.key).toBe("p20261120");
    expect(iso(p.startsAt)).toBe("2026-11-20T21:15:00.000Z");
    expect(iso(p.endsAt)).toBe("2026-11-21T21:15:00.000Z");
    expect(emailRevealPeriod(new Date(p.endsAt.getTime() - 1)).key).toBe(p.key);
    expect(emailRevealPeriod(p.endsAt).key).not.toBe(p.key);
    expect(emailRevealPeriod(p.startsAt).key).toBe(p.key);
  });

  it("spring forward (Mar 8 2026, 02:00 -> 03:00): the period across it is 23 hours, and 13:15 on both sides is still 13:15 local", () => {
    const before = at("2026-03-08T10:00:00Z"); // 02:00 PST... the clocks jump at 10:00Z
    expect(before.key).toBe("p20260307");
    expect(iso(before.startsAt)).toBe("2026-03-07T21:15:00.000Z"); // 13:15 PST
    expect(iso(before.endsAt)).toBe("2026-03-08T20:15:00.000Z"); // 13:15 PDT
    expect(before.endsAt.getTime() - before.startsAt.getTime()).toBe(23 * 3600_000);
    expect(at("2026-03-08T20:14:59Z").key).toBe("p20260307");
    expect(at("2026-03-08T20:15:00Z").key).toBe("p20260308");
  });

  it("fall back (Nov 1 2026, 02:00 -> 01:00): the period across it is 25 hours", () => {
    const across = at("2026-11-01T09:00:00Z");
    expect(across.key).toBe("p20261031");
    expect(iso(across.startsAt)).toBe("2026-10-31T20:15:00.000Z"); // 13:15 PDT
    expect(iso(across.endsAt)).toBe("2026-11-01T21:15:00.000Z"); // 13:15 PST
    expect(across.endsAt.getTime() - across.startsAt.getTime()).toBe(25 * 3600_000);
    expect(at("2026-11-01T21:14:59Z").key).toBe("p20261031");
    expect(at("2026-11-01T21:15:00Z").key).toBe("p20261101");
  });

  it("year and month rollovers produce valid keys", () => {
    expect(at("2027-01-01T09:00:00Z").key).toBe("p20261231");
    expect(at("2027-01-01T21:15:00Z").key).toBe("p20270101");
    expect(at("2028-03-01T09:00:00Z").key).toBe("p20280229"); // leap day
  });

  it("the key fits the VarChar(10) column that stores it, and can never equal a legacy yyyy-MM-dd key", () => {
    for (const d of ["2026-01-01T00:00:00Z", "2026-07-04T12:00:00Z", "2026-12-31T23:59:59Z"]) {
      const k = at(d).key;
      expect(k.length).toBeLessThanOrEqual(10);
      expect(k).toMatch(/^p\d{8}$/);
      expect(k).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
