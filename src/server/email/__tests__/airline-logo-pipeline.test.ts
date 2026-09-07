import { describe, it, expect } from "vitest";
import { toEmailSegments } from "../segment-mapper";
import {
  buildQuoteEmail,
  buildBookingConfirmationEmail,
  buildCancellationScheduledEmail,
  buildCancellationConfirmedEmail,
  buildBookingProfitNotificationEmail,
} from "../templates";
import type { ResolvedCompanyBranding } from "@/lib/company-config";

// Pass 18 — the airline-logo bug report: an internal cancellation
// notification showed the correct itinerary text ("American Airlines AA
// 100") but NO airline logo image. This suite proves, through the REAL
// end-to-end path (raw Prisma-shaped segment -> toEmailSegments -> the
// actual email builder), that the generated HTML contains a real,
// absolute, externally-resolvable <img> tag for a representative set of
// airlines and email types — not merely that a lower-level resolver
// function returns a truthy value. A passing airline-logo unit test can
// still coexist with a broken final email; these tests inspect the final
// HTML string every builder actually returns.

const TEST_COMPANY: ResolvedCompanyBranding = {
  id: "test-company",
  name: "Test Travel Co",
  website: "https://test.example.com",
  phone: "+1 555 000 0000",
  brandColor: "#1c3a5e",
  logoEmailUrl: "https://test.example.com/logo-email.png",
  logoWebUrl: "https://test.example.com/logo-web.png",
  logoIconUrl: "https://test.example.com/logo-icon.png",
  signatureTemplate: "Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}",
};

type RawSegment = Parameters<typeof toEmailSegments>[0][number];

function rawSegment(overrides: Partial<RawSegment> = {}): RawSegment {
  return {
    id: "seg-1",
    flightNumber: "100",
    bookingClass: "Y",
    cabin: "ECONOMY",
    departureAt: new Date("2026-10-14T09:00:00Z"),
    arrivalAt: new Date("2026-10-14T17:20:00Z"),
    durationMinutes: 320,
    airlineCodeRaw: "AA",
    connectionType: null,
    airline: { name: "American Airlines", iata: "AA", icao: "AAL", logoUrl: null },
    aircraftType: null,
    aircraftRaw: null,
    operatingCarrierName: null,
    departureAirport: { iata: "LAX", city: "Los Angeles" },
    arrivalAirport: { iata: "JFK", city: "New York" },
    isExtraLeg: false,
    ...overrides,
  };
}

/** The exact real bug-report scenario: LAX -> JFK, American Airlines AA 100. */
function bugReportSegments() {
  return toEmailSegments([rawSegment()]);
}

const NOTIFICATION_BASE = {
  agentFullName: "Nigora Dadabaeva",
  agentRole: "Travel Agent",
  agentLocation: "Frankfurt",
  hireAgeCompact: "0Y0M11D",
  profit: 287,
  destination: "Minneapolis, United States",
  currency: "USD" as const,
  bookingReference: "BK-3921",
  passengerCount: 2,
  ticketBookingCost: 3800,
  sellingCost: 4087,
  company: TEST_COMPANY,
};

function expectRealLogoImg(html: string, iata: string) {
  const expectedUrl = `https://images.kiwi.com/airlines/64x64/${iata.toUpperCase()}.png`;
  expect(html).toContain(`<img src="${expectedUrl}"`);
  // Absolute, HTTPS, externally resolvable — never a relative path, a
  // localhost/dev URL, or a browser-only Next.js image-optimization route.
  expect(html).not.toMatch(/<img src="\/(?!\/)/); // no img starting with a single "/"
  expect(html).not.toContain("localhost");
  expect(html).not.toContain("/_next/image");
  expect(html).not.toContain("undefined");
  expect(html).not.toContain(">null<");
}

describe("airline logo — end-to-end through the exact reported bug scenario (AA 100, LAX -> JFK)", () => {
  it("internal CANCELLATION notification contains the American Airlines logo, not just the text", () => {
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, transactionLabel: "CANCELLATION", segments: bugReportSegments() });
    expect(html).toContain("American Airlines");
    expect(html).toContain("AA 100");
    expectRealLogoImg(html, "AA");
  });

  it("internal NEW SALE notification contains the American Airlines logo", () => {
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, segments: bugReportSegments() });
    expectRealLogoImg(html, "AA");
  });

  it("internal EXCHANGE notification contains the American Airlines logo", () => {
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, transactionLabel: "EXCHANGE", segments: bugReportSegments() });
    expectRealLogoImg(html, "AA");
  });

  it("customer quote email contains the American Airlines logo", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Andrew",
      agentFullName: "Jane Doe",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: bugReportSegments(),
      pricing: { adults: 1, children: 0, infants: 0, adultPrice: 1000, childPrice: 0, infantPrice: 0, taxes: 0, serviceFee: 0, gratuity: 0, total: 1000 },
      viewDealUrl: "https://example.com/quote/abc",
      company: TEST_COMPANY,
    });
    expectRealLogoImg(html, "AA");
  });

  it("customer booking confirmation email contains the American Airlines logo", () => {
    const { html } = buildBookingConfirmationEmail({
      customerFirstName: "Andrew",
      bookingReference: "BK-1",
      segments: bugReportSegments(),
      pricing: { adults: 1, children: 0, infants: 0, adultPrice: 1000, childPrice: 0, infantPrice: 0, taxes: 0, serviceFee: 0, gratuity: 0, total: 1000 },
      paymentMethods: [],
      paymentPaid: true,
      passengers: [{ firstName: "Andrew", middleName: null, lastName: "Kent", dateOfBirth: null, type: "ADULT" }],
      contactName: "Andrew Kent",
      contactEmail: "andrew@example.com",
      contactPhone: "555-1212",
      confirmations: [{ id: "1", airlineName: null, confirmationNumber: "ABC123", eTicketNumbers: [] }],
      company: TEST_COMPANY,
    });
    expectRealLogoImg(html, "AA");
  });

  it("customer cancellation-scheduled email contains the American Airlines logo for the affected segment", () => {
    const segs = bugReportSegments();
    const { html } = buildCancellationScheduledEmail({
      customerFirstName: "Andrew",
      agentFullName: "Jane Doe",
      segments: segs,
      cancelledSegmentIds: new Set([segs[0].id!]),
      viewDealUrl: "https://example.com/quote/abc",
      company: TEST_COMPANY,
    });
    expectRealLogoImg(html, "AA");
  });

  it("customer cancellation-confirmed email contains the American Airlines logo", () => {
    const segs = bugReportSegments();
    const { html } = buildCancellationConfirmedEmail({
      customerFirstName: "Andrew",
      agentFullName: "Jane Doe",
      segments: segs,
      cancelledSegmentIds: new Set([segs[0].id!]),
      company: TEST_COMPANY,
    });
    expectRealLogoImg(html, "AA");
  });
});

describe("airline logo — representative multi-region matrix", () => {
  // Real IATA codes for well-known carriers across regions, matching the
  // exact hierarchy resolveAirlineDisplay/toEmailSegments already
  // implement — this is a DB-independent unit test (plain fixture
  // objects, not a live-database query), so codes were chosen to be
  // realistic and instantly recognizable rather than pulled from a live
  // query, which the reference-data.test.ts suite already covers
  // separately against the real database.
  const carriers: Array<{ label: string; iata: string; icao: string; name: string }> = [
    { label: "major US carrier", iata: "AA", icao: "AAL", name: "American Airlines" },
    { label: "major European carrier", iata: "LH", icao: "DLH", name: "Lufthansa" },
    { label: "major Middle Eastern carrier", iata: "EK", icao: "UAE", name: "Emirates" },
    { label: "major Asian carrier", iata: "SQ", icao: "SIA", name: "Singapore Airlines" },
    { label: "low-cost carrier", iata: "FR", icao: "RYR", name: "Ryanair" },
    { label: "airline with a longer name", iata: "TP", icao: "TAP", name: "TAP Air Portugal" },
  ];

  it.each(carriers)("$label ($iata / $name) resolves to its own correct logo, not a generic or mismatched one", ({ iata, icao, name }) => {
    const segs = toEmailSegments([rawSegment({ airline: { name, iata, icao, logoUrl: null }, airlineCodeRaw: iata })]);
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, segments: segs });
    expectRealLogoImg(html, iata);
    expect(html).toContain(name);
    // Never another carrier's logo from this same matrix.
    for (const other of carriers) {
      if (other.iata === iata) continue;
      expect(html).not.toContain(`https://images.kiwi.com/airlines/64x64/${other.iata}.png`);
    }
  });

  it("an explicit database Airline.logoUrl always wins over the CDN-derived fallback", () => {
    const segs = toEmailSegments([
      rawSegment({ airline: { name: "British Airways", iata: "BA", icao: "BAW", logoUrl: "https://cdn.compass-tools.example.com/airlines/ba-verified.png" } }),
    ]);
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, segments: segs });
    expect(html).toContain('<img src="https://cdn.compass-tools.example.com/airlines/ba-verified.png"');
    expect(html).not.toContain("images.kiwi.com/airlines/64x64/BA.png");
  });

  it("lowercase airline code on the raw parsed data still resolves the correct logo (case-insensitive, not just at the DB-query layer)", () => {
    const segs = toEmailSegments([rawSegment({ airline: { name: "American Airlines", iata: "aa", icao: "AAL", logoUrl: null }, airlineCodeRaw: "aa" })]);
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, segments: segs });
    // airlineLogoUrl() uppercases before constructing the URL — the actual
    // <img> src must always be the canonical uppercase form regardless of
    // how the airline's own iata column happened to be cased.
    expect(html).toContain('<img src="https://images.kiwi.com/airlines/64x64/AA.png"');
  });
});

describe("airline logo — missing/unresolvable data never produces a broken image experience", () => {
  it("airline relation genuinely unresolved (only raw GDS text, e.g. an unmatched numeric code): no <img> tag, no broken-image risk, professional text fallback instead", () => {
    const segs = toEmailSegments([rawSegment({ airline: null, airlineCodeRaw: "28" })]);
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, segments: segs });
    expect(html).not.toContain("<img src=\"https://images.kiwi.com");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain(">null<");
    // The raw code still renders as plain text so the itinerary is never
    // silently blank — this is the same graceful boxed-code fallback the
    // CRM's own web itinerary display uses.
    expect(html).toContain("28");
  });

  it("a resolved airline whose DB row has neither iata nor a stored logoUrl (ICAO-only reference row): text identity still renders, no broken <img>", () => {
    const segs = toEmailSegments([rawSegment({ airline: { name: "Regional Carrier", iata: null, icao: "RGC", logoUrl: null }, airlineCodeRaw: "RGC" })]);
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, segments: segs });
    expect(html).not.toContain("<img src=\"https://images.kiwi.com");
    expect(html).toContain("Regional Carrier");
  });

  it("an unknown/unresolvable airline code never guesses a logo URL from unverified raw text (a real code coincidence would show the WRONG airline's logo)", () => {
    // "28" happens to pass the bare IATA_CODE_PATTERN shape check (2
    // alphanumeric chars) but was never verified against the reference
    // table — the resolver must never construct a CDN guess from it.
    const segs = toEmailSegments([rawSegment({ airline: null, airlineCodeRaw: "28" })]);
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, segments: segs });
    expect(html).not.toContain("images.kiwi.com/airlines/64x64/28.png");
  });
});

describe("airline logo — codeshare / operating carrier", () => {
  it("displays the MARKETING carrier's logo (the one on the flight number shown), not the operating carrier's", () => {
    const segs = toEmailSegments([
      rawSegment({
        airline: { name: "American Airlines", iata: "AA", icao: "AAL", logoUrl: null },
        operatingCarrierName: "PAL Express",
      }),
    ]);
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, segments: segs });
    expectRealLogoImg(html, "AA");
    expect(html).toContain("Operated by PAL Express");
    // Never a coincidental logo for the operating-carrier text, which was
    // never resolved against the Airline table at all (see
    // resolveOperatingCarrierLabel's own doc comment).
    expect(html).not.toContain("images.kiwi.com/airlines/64x64/PA.png");
  });
});

describe("airline logo — multi-segment itineraries with different airlines", () => {
  it("each segment renders its own correct, independent logo — no cross-contamination between segments", () => {
    const segs = toEmailSegments([
      rawSegment({ id: "seg-a", airline: { name: "American Airlines", iata: "AA", icao: "AAL", logoUrl: null } }),
      rawSegment({
        id: "seg-b",
        airline: { name: "Lufthansa", iata: "LH", icao: "DLH", logoUrl: null },
        departureAirport: { iata: "JFK", city: "New York" },
        arrivalAirport: { iata: "FRA", city: "Frankfurt" },
        connectionType: "LAYOVER",
      }),
    ]);
    const { html } = buildBookingProfitNotificationEmail({ ...NOTIFICATION_BASE, segments: segs });
    expectRealLogoImg(html, "AA");
    expect(html).toContain("https://images.kiwi.com/airlines/64x64/LH.png");
  });
});
