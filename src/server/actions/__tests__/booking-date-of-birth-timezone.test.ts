import { describe, it, expect } from "vitest";

// Regression test for a real bug found during the pre-launch QA pass: a
// passenger's date of birth (submitted by the customer as a plain
// "YYYY-MM-DD" string, with no time-of-day meaning at all) was being
// constructed with `new Date(p.dateOfBirth)` and displayed with date-fns's
// `format()` on the Booking detail page (src/app/(crm)/bookings/[id]/
// page.tsx) — format() renders in the SERVER PROCESS's local timezone,
// so a passenger who typed "Aug 15, 1990" could see "Aug 14, 1990" on the
// CRM booking page whenever the server ran in a timezone behind UTC. This
// is exactly the class of bug that varies by deployment environment (dev
// machine vs. production server timezone) and would be easy to miss in
// code review alone.
//
// The fix follows this codebase's own already-correct, established
// pattern for date-only fields (see Account.hiredAt's write site in
// account-row-editor.tsx and its display in accounts/page.tsx, and the
// quote page's OTHER passenger-DOB display in
// signed-booking-details-card.tsx, which was never affected because it
// already used this exact pattern): write with an explicit UTC-midnight
// anchor, display with an explicit UTC timezone — both independent of
// whatever timezone the Node process happens to be running in.

describe("Passenger.dateOfBirth — timezone-independent round trip", () => {
  it("writing with an explicit UTC-midnight anchor always yields the calendar date the customer typed, regardless of server timezone", () => {
    const submitted = "1990-08-15"; // exactly what the customer's date picker sends
    const stored = new Date(`${submitted}T00:00:00.000Z`);
    expect(stored.toISOString()).toBe("1990-08-15T00:00:00.000Z");
    // The UTC calendar-date components are what matter — these are the
    // same regardless of which timezone reads this Date back.
    expect(stored.getUTCFullYear()).toBe(1990);
    expect(stored.getUTCMonth()).toBe(7); // 0-indexed: August
    expect(stored.getUTCDate()).toBe(15);
  });

  it("the OLD unanchored construction was also UTC-correct in isolation — the bug was specifically in how it later got displayed, not in this parse", () => {
    // Documents why the bug was subtle: `new Date("YYYY-MM-DD")` alone
    // already parses as UTC midnight per the ECMAScript spec...
    const stored = new Date("1990-08-15");
    expect(stored.toISOString()).toBe("1990-08-15T00:00:00.000Z");
  });

  it("displaying with an explicit UTC timezone always renders the correct calendar day, unlike a local-timezone-implicit formatter", () => {
    const stored = new Date("1990-08-15T00:00:00.000Z");
    const displayed = stored.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    expect(displayed).toBe("Aug 15, 1990");
  });

  it("the same value formatted in a timezone behind UTC (the exact failure mode found live) shifts back a calendar day — demonstrating why an explicit UTC timezone is required, not optional, for a date-only field", () => {
    const stored = new Date("1990-08-15T00:00:00.000Z");
    // America/Los_Angeles is behind UTC year-round (UTC-7 or UTC-8) — any
    // local-timezone-implicit formatter (e.g. date-fns's format(), or
    // toLocaleDateString() without an explicit timeZone) run on a server
    // in or west of that offset renders the PREVIOUS calendar day for a
    // UTC-midnight instant.
    const wronglyLocalized = stored.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
    expect(wronglyLocalized).toBe("Aug 14, 1990");
    expect(wronglyLocalized).not.toBe("Aug 15, 1990");
  });
});
