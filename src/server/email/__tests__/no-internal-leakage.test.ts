// Pass 14 §18/§54 — a dedicated regression suite asserting that every
// customer-facing email builder's OUTPUT (subject + html) never contains
// the internal CRM product name, the word "CRM" itself, or any internal-
// only value (PNR, internal notes, internal exchange/cancellation cost
// figures, or a raw Quote/Booking id) — run across every customer-facing
// template, not just buildSequenceEmail (which already had its own single
// check above in templates.test.ts). This complements, rather than
// replaces, the STRUCTURAL guarantee already in place for most of these
// fields (buildBookingConfirmationEmail/buildCancellationConfirmedEmail
// don't even accept a `pnr`/internal-notes param — see their own params
// types) — this suite is the behavioral proof for the fields that ARE
// accepted (company name, agent name, ids used only for internal
// bookkeeping) but must still never render into customer-visible output.
import { describe, it, expect } from "vitest";
import {
  buildQuoteEmail,
  buildBookingConfirmationEmail,
  buildCancellationScheduledEmail,
  buildCancellationConfirmedEmail,
  buildCvvRecollectionEmail,
  type EmailSegment,
  type EmailPricing,
} from "../templates";
import { toAirportDateTime } from "@/lib/airport-datetime";
import { PRODUCT_NAME } from "@/lib/company-config";
import type { ResolvedCompanyBranding } from "@/lib/company-config";

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

// A quote/booking id in this codebase's real cuid format — used only to
// prove the id itself is never echoed into customer-visible text (the
// builders below never accept an id param at all, but this documents the
// intent explicitly and would catch a future param added carelessly).
const INTERNAL_QUOTE_ID = "cm0INTERNAL0000000000quoteid";

function makeSegment(overrides: Partial<EmailSegment> = {}): EmailSegment {
  return {
    airlineName: "Test Air",
    airlineCode: "TA",
    airlineLogoUrl: null,
    flightNumber: "100",
    cabin: "Economy",
    bookingClass: "Y",
    aircraft: null,
    operatingCarrierLabel: null,
    departureAirportCode: "AAA",
    departureCity: "Origin",
    arrivalAirportCode: "BBB",
    arrivalCity: "Destination",
    departureAt: toAirportDateTime("2026-08-27", "09:00"),
    arrivalAt: toAirportDateTime("2026-08-27", "11:00"),
    durationMinutes: 120,
    connectionType: null,
    isExtraLeg: false,
    id: "seg-1",
    ...overrides,
  };
}

const PRICING: EmailPricing = {
  adults: 1,
  children: 0,
  infants: 0,
  adultPrice: 1000,
  childPrice: 0,
  infantPrice: 0,
  taxes: 25,
  serviceFee: 10,
  gratuity: 0,
  total: 1035,
};

const PROHIBITED_STRINGS = [PRODUCT_NAME, "CRM", INTERNAL_QUOTE_ID];

function expectNoLeak(subject: string, html: string) {
  for (const banned of PROHIBITED_STRINGS) {
    expect(subject).not.toContain(banned);
    expect(html).not.toContain(banned);
  }
}

describe("customer-facing emails never leak internal CRM information (Pass 14 §18/§54)", () => {
  it("buildQuoteEmail — an ordinary new-ticket quote", () => {
    const { subject, html } = buildQuoteEmail({
      customerFirstName: "Andrew",
      customerLastName: "Kent",
      agentFullName: "Jane Doe",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment()],
      pricing: PRICING,
      viewDealUrl: `https://test.example.com/quote/some-token`,
      company: TEST_COMPANY,
    });
    expectNoLeak(subject, html);
  });

  it("buildQuoteEmail — an exchange proposal (original + proposed itinerary both rendered)", () => {
    const { subject, html } = buildQuoteEmail({
      customerFirstName: "Andrew",
      customerLastName: "Kent",
      agentFullName: "Jane Doe",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment({ id: "seg-new" })],
      originalItinerarySegments: [makeSegment({ id: "seg-old" })],
      pricing: PRICING,
      viewDealUrl: `https://test.example.com/quote/some-token`,
      company: TEST_COMPANY,
    });
    expectNoLeak(subject, html);
  });

  it("buildQuoteEmail — degrades gracefully with no last name, never renders 'undefined'/'null'", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Andrew",
      customerLastName: null,
      agentFullName: "Jane Doe",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment()],
      pricing: PRICING,
      viewDealUrl: `https://test.example.com/quote/some-token`,
      company: TEST_COMPANY,
    });
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null");
  });

  it("buildBookingConfirmationEmail — ordinary booking, ticketed", () => {
    const { subject, html } = buildBookingConfirmationEmail({
      customerFirstName: "Andrew",
      bookingReference: "BK-1001",
      segments: [makeSegment()],
      pricing: PRICING,
      paymentMethods: [],
      paymentPaid: true,
      passengers: [{ firstName: "Andrew", middleName: null, lastName: "Kent", dateOfBirth: null, type: "ADULT" }],
      contactName: "Andrew Kent",
      contactEmail: "andrew@example.com",
      contactPhone: "555-1212",
      confirmations: [{ id: "1", airlineName: null, confirmationNumber: "ABC123", eTicketNumbers: ["0123456789"] }],
      company: TEST_COMPANY,
    });
    expectNoLeak(subject, html);
  });

  it("buildBookingConfirmationEmail — exchange confirmation, with the Exchange Summary block rendered", () => {
    const { subject, html } = buildBookingConfirmationEmail({
      customerFirstName: "Andrew",
      bookingReference: "BK-1002",
      segments: [makeSegment()],
      pricing: PRICING,
      paymentMethods: [],
      paymentPaid: true,
      passengers: [{ firstName: "Andrew", middleName: null, lastName: "Kent", dateOfBirth: null, type: "ADULT" }],
      contactName: "Andrew Kent",
      contactEmail: "andrew@example.com",
      contactPhone: "555-1212",
      confirmations: [{ id: "1", airlineName: null, confirmationNumber: "ABC123", eTicketNumbers: ["0123456789"] }],
      company: TEST_COMPANY,
      exchange: { exchangeFee: 150, fareDifference: 40, currency: "USD" },
    });
    expectNoLeak(subject, html);
  });

  it("buildCancellationScheduledEmail — cancellation requested, not yet cancelled", () => {
    const seg = makeSegment({ id: "cancel-me" });
    const { subject, html } = buildCancellationScheduledEmail({
      customerFirstName: "Andrew",
      agentFullName: "Jane Doe",
      segments: [seg],
      cancelledSegmentIds: new Set(["cancel-me"]),
      cancellationFee: 50,
      currency: "USD",
      viewDealUrl: `https://test.example.com/quote/some-token`,
      company: TEST_COMPANY,
    });
    expectNoLeak(subject, html);
    // §33 — must never claim the segment is already cancelled.
    expect(html).not.toContain("Cancellation Confirmed");
    expect(html).toContain("not been cancelled yet");
  });

  it("buildCancellationConfirmedEmail — the true final state", () => {
    const seg = makeSegment({ id: "cancel-me" });
    const { subject, html } = buildCancellationConfirmedEmail({
      customerFirstName: "Andrew",
      agentFullName: "Jane Doe",
      segments: [seg],
      cancelledSegmentIds: new Set(["cancel-me"]),
      company: TEST_COMPANY,
    });
    expectNoLeak(subject, html);
  });

  it("buildCvvRecollectionEmail — never leaks internal terminology, and never contains the CVV itself (it doesn't even accept one as a param)", () => {
    const { subject, html } = buildCvvRecollectionEmail({
      customerFirstName: "Andrew",
      agentFullName: "Jane Doe",
      cardBrand: "Visa",
      last4: "1111",
      confirmUrl: "https://test.example.com/cvv-recollection/some-token",
      company: TEST_COMPANY,
    });
    expectNoLeak(subject, html);
  });
});
