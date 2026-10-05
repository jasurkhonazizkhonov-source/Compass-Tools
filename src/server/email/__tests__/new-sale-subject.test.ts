import { describe, it, expect } from "vitest";
import { buildNewSaleSubject, buildBookingProfitNotificationEmail } from "../templates";
import { formatHireAgeCompact } from "@/lib/account-format";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const NOW = new Date("2026-10-05T15:30:00.000Z");

describe("formatHireAgeCompact — exact calendar Y/M/D, never totals or approximations", () => {
  const cases: Array<[string, string, string]> = [
    // hired, now, expected
    ["2026-09-24", "2026-10-05", "0Y0M11D"], // the spec's own example: 11 days ago
    ["2026-10-05", "2026-10-05", "0Y0M0D"],
    ["2025-12-15", "2026-10-05", "0Y9M20D"], // spans a calendar-year boundary (used to render "1Y-2M0D")
    ["2016-11-02", "2026-10-05", "9Y11M3D"], // not yet the 10-year anniversary (used to render "10Y-1M3D")
    ["2021-10-05", "2026-10-05", "5Y0M0D"],
    ["2021-10-02", "2026-10-05", "5Y0M3D"],
    ["2015-11-07", "2026-10-05", "10Y10M28D"],
    ["2025-10-21", "2026-10-05", "0Y11M14D"],
    ["2025-08-22", "2026-10-05", "1Y1M13D"],
    ["2024-08-21", "2026-10-05", "2Y1M14D"],
    ["2024-02-29", "2025-03-01", "1Y0M1D"], // leap day hire
    ["2024-02-29", "2026-02-28", "2Y0M0D"], // a month-end anniversary clamps to the last day of a shorter month
    ["2026-01-31", "2026-03-01", "0Y1M1D"], // month-end anniversary clamps to Feb 28
    ["2026-08-31", "2026-10-01", "0Y1M1D"],
    ["2026-08-31", "2026-09-30", "0Y1M0D"],
    ["2026-08-31", "2026-09-29", "0Y0M29D"],
    ["2026-01-01", "2026-12-31", "0Y11M30D"],
  ];
  it.each(cases)("hired %s, today %s -> %s", (hired, today, expected) => {
    expect(formatHireAgeCompact(d(hired), new Date(`${today}T15:30:00.000Z`))).toBe(expected);
  });

  it("never produces a negative or out-of-range component", () => {
    for (let y = 2015; y <= 2026; y++) {
      for (let m = 1; m <= 12; m++) {
        for (const day of [1, 15, 28, 29, 30, 31]) {
          const hired = new Date(Date.UTC(y, m - 1, day));
          if (hired.getUTCMonth() !== m - 1) continue; // not a real date
          const out = formatHireAgeCompact(hired, NOW);
          if (hired.getTime() > NOW.getTime()) continue;
          expect(out).toMatch(/^\d+Y(\d|1[01])M(\d|[12]\d|3[01])D$/);
        }
      }
    }
  });

  it("is independent of the time of day and of the machine's zone (UTC calendar days)", () => {
    expect(formatHireAgeCompact(d("2026-09-24"), new Date("2026-10-05T00:00:00.000Z"))).toBe("0Y0M11D");
    expect(formatHireAgeCompact(d("2026-09-24"), new Date("2026-10-05T23:59:59.999Z"))).toBe("0Y0M11D");
  });

  it("returns null with no hire date, a future hire date or an invalid date — never fabricates", () => {
    expect(formatHireAgeCompact(null, NOW)).toBeNull();
    expect(formatHireAgeCompact(d("2026-10-06"), NOW)).toBeNull();
    expect(formatHireAgeCompact(new Date("nope"), NOW)).toBeNull();
  });
});

describe("buildNewSaleSubject — the exact required structure", () => {
  const base = { agentFullName: "Andrew Kent", agentLocation: "Frankfurt", hireAgeCompact: "0Y0M11D", amount: "$287.00", destination: "Minneapolis, United States" };

  it("normal sale: no suffix", () => {
    expect(buildNewSaleSubject(base)).toBe("Andrew Kent (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States");
  });
  it("exchange: ' on Exchange' at the very end", () => {
    expect(buildNewSaleSubject({ ...base, label: "EXCHANGE" })).toBe("Andrew Kent (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States on Exchange");
  });
  it("cancellation: ' on Cancellation' at the very end", () => {
    expect(buildNewSaleSubject({ ...base, label: "CANCELLATION" })).toBe("Andrew Kent (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States on Cancellation");
  });
  it("missing location: only the hire age is shown; missing both: no parenthetical", () => {
    expect(buildNewSaleSubject({ ...base, agentLocation: null })).toBe("Andrew Kent (hire age: 0Y0M11D) made $287.00 to Minneapolis, United States");
    expect(buildNewSaleSubject({ ...base, agentLocation: "   " })).toBe("Andrew Kent (hire age: 0Y0M11D) made $287.00 to Minneapolis, United States");
    expect(buildNewSaleSubject({ ...base, agentLocation: null, hireAgeCompact: null })).toBe("Andrew Kent made $287.00 to Minneapolis, United States");
  });
  it("missing hire date: location only", () => {
    expect(buildNewSaleSubject({ ...base, hireAgeCompact: null })).toBe("Andrew Kent (Frankfurt) made $287.00 to Minneapolis, United States");
  });
  it("special characters in names survive; line breaks cannot inject a header", () => {
    expect(buildNewSaleSubject({ ...base, agentFullName: "Zoë O'Brien-Müller" })).toContain("Zoë O'Brien-Müller (Frankfurt");
    const injected = buildNewSaleSubject({ ...base, agentFullName: "Eve\r\nBcc: evil@example.com", agentLocation: "Paris\nX: y" });
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).toBe("Eve Bcc: evil@example.com (Paris X: y, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States");
  });
});

describe("the real template uses the helper: amount, destination and label wiring", () => {
  const company = { id: "c", name: "Compass Tools", brandColor: "#2563eb", logoEmailUrl: null, website: null, phone: null, signatureTemplate: "", supportEmail: null } as never;
  const build = (over: Partial<Parameters<typeof buildBookingProfitNotificationEmail>[0]> = {}) =>
    buildBookingProfitNotificationEmail({
      agentFullName: "Andrew Kent",
      agentLocation: "Frankfurt",
      hireAgeCompact: "0Y0M11D",
      profit: 287,
      destination: "Minneapolis, United States",
      currency: "USD",
      bookingReference: "BFT-1",
      passengerCount: 1,
      ticketBookingCost: 500,
      sellingCost: 787,
      segments: [],
      company,
      ...over,
    }).subject;

  it("formats amounts to two decimals with the $ sign, thousands separators and a leading minus for a loss", () => {
    expect(build({ profit: 287 })).toContain("made $287.00 to");
    expect(build({ profit: 287.5 })).toContain("made $287.50 to");
    expect(build({ profit: 1234.5 })).toContain("made $1,234.50 to");
    expect(build({ profit: 0 })).toContain("made $0.00 to");
    expect(build({ profit: -12.5 })).toContain("made -$12.50 to");
  });
  it("normal / isExchange / transactionLabel map to the right suffix and nothing else", () => {
    expect(build()).toBe("Andrew Kent (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States");
    expect(build({ isExchange: true })).toBe("Andrew Kent (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States on Exchange");
    expect(build({ transactionLabel: "EXCHANGE" })).toMatch(/ on Exchange$/);
    expect(build({ transactionLabel: "CANCELLATION" })).toBe("Andrew Kent (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States on Cancellation");
    expect(build({ transactionLabel: "CANCELLATION", isExchange: true })).toMatch(/ on Cancellation$/);
  });
  it("multi-city: the destination passed in (the caller's last non-extra leg) is used verbatim, never an IATA code", () => {
    const s = build({ destination: "Tokyo, Japan" });
    expect(s).toContain("to Tokyo, Japan");
    expect(s).not.toMatch(/\b[A-Z]{3}\b/);
  });
  it("has no company suffix, booking reference, or internal id in the subject", () => {
    const s = build();
    expect(s).not.toContain("Compass Tools");
    expect(s).not.toContain("BFT-");
  });
});
