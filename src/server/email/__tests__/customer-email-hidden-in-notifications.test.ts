import { describe, it, expect } from "vitest";
import { HIDDEN_CUSTOMER_EMAIL_NOTE, buildBookingSignedNotificationEmail, buildContactReassignmentEmail, buildNewFlightRequestEmail, buildLeadReassignmentEmail, type EmailPricing } from "../templates";
import type { ResolvedCompanyBranding } from "@/lib/company-config";

// Internal notification emails for a recipient who may NOT see complete customer addresses: the address, its mailto link and the "Reply" button are absent from the HTML
// (these builders produce HTML only - there is no plain-text body), and the email stays useful. For a recipient who may see it, nothing changes.

const ADDRESS = "private.customer@example.org";
const COMPANY: ResolvedCompanyBranding = { id: "c", name: "Test Travel Co", website: "https://t.example.com", phone: null, brandColor: "#1c3a5e", logoEmailUrl: "", logoWebUrl: "", logoIconUrl: "", signatureTemplate: "" };
const PRICING: EmailPricing = { adults: 1, children: 0, infants: 0, adultPrice: 1000, childPrice: 0, infantPrice: 0, taxes: 0, serviceFee: 0, gratuity: 0, total: 1000 };

const booking = (hidden: boolean) =>
  buildBookingSignedNotificationEmail({
    bookingReference: "BFT-1", customerFullName: "Jane Doe", contactEmail: hidden ? "" : ADDRESS, contactEmailHidden: hidden, contactPhone: "+15551234567", signedName: "Jane Doe",
    signedAt: new Date("2026-01-01T00:00:00Z"), ipAddress: null, segments: [], passengers: [], pricing: PRICING, paymentMethods: [], paymentPaid: false, bookingUrl: "https://t.example.com/bookings/1", company: COMPANY,
  });

const flight = (hidden: boolean) => ({
  company: COMPANY, customerFullName: "Jordan Rivera", customerEmail: hidden ? null : ADDRESS, customerEmailHidden: hidden, customerPhone: "+14155550123", customerPhoneDisplay: "+1 415 555 0123", customerCountry: "United States",
  tripType: "ROUND_TRIP" as const, cabinClass: "ECONOMY" as const, adults: 1, children: 0, infants: 0, departureAirport: { iata: "LAX", name: "Los Angeles", city: "Los Angeles", country: "US" }, arrivalAirport: { iata: "CDG", name: "Charles de Gaulle", city: "Paris", country: "FR" },
  departureDate: new Date("2026-11-03T00:00:00Z"), returnDate: null, segments: [], flexibleDates: false, preferredAirline: null, budget: null, notes: null, submittedAt: new Date("2026-10-01T15:00:00Z"), acceptedAt: new Date("2026-10-01T15:05:00Z"), acceptedByName: "Agent A",
});

describe("Booking Form Signed notification", () => {
  it("hidden: no address, the note instead; the booking reference, customer name and phone remain", () => {
    const { html, subject } = booking(true);
    expect(html).not.toContain(ADDRESS);
    expect(html).toContain(HIDDEN_CUSTOMER_EMAIL_NOTE);
    expect(html).toContain("Jane Doe");
    expect(html).toContain("+15551234567");
    expect(subject).not.toContain("@");
  });
  it("shown: unchanged", () => {
    expect(booking(false).html).toContain(ADDRESS);
    expect(booking(false).html).not.toContain(HIDDEN_CUSTOMER_EMAIL_NOTE);
  });
});

describe("New Flight Request and lead reassignment", () => {
  it("hidden: no address, no mailto, no Reply button; trip, phone and Call button remain", () => {
    for (const html of [
      buildNewFlightRequestEmail(flight(true)).html,
      buildLeadReassignmentEmail({ ...flight(true), direction: "TO_YOU", recipientFullName: "Agent A", status: "NEW", source: "WEBSITE", newOwnerName: "Agent A", previousOwnerName: null, reassignedByName: "Admin", reassignedAt: new Date("2026-10-02T00:00:00Z"), reason: null, leadUrl: null } as never).html,
    ]) {
      expect(html).not.toContain(ADDRESS);
      expect(html).not.toMatch(/mailto:/i);
      expect(html).not.toContain("Reply to Client");
      expect(html).toContain(HIDDEN_CUSTOMER_EMAIL_NOTE);
      expect(html).toContain("Charles de Gaulle");
      expect(html).toContain("tel:+14155550123");
    }
  });
  it("shown: address, mailto and Reply button as before", () => {
    const html = buildNewFlightRequestEmail(flight(false)).html;
    expect(html).toContain(`mailto:${ADDRESS}`);
    expect(html).toContain("Reply to Client");
  });
});

describe("Contact reassignment (to the new owner)", () => {
  const base = { company: COMPANY, direction: "TO_YOU" as const, recipientFullName: "Agent A", contactFullName: "Jordan Rivera", contactPhone: "+14155550123", contactPhoneDisplay: "+1 415 555 0123", contactCountry: "United States", leadCount: 2, newOwnerName: "Agent A", previousOwnerName: null, reassignedByName: "Admin", reassignedAt: new Date("2026-10-02T00:00:00Z"), reason: null, contactUrl: null };
  it("hidden: no address or mailto, note instead, the rest stays", () => {
    const { html } = buildContactReassignmentEmail({ ...base, contactEmail: null, contactEmailHidden: true });
    expect(html).not.toContain(ADDRESS);
    expect(html).not.toMatch(/mailto:/i);
    expect(html).toContain(HIDDEN_CUSTOMER_EMAIL_NOTE);
    expect(html).toContain("tel:+14155550123");
    expect(html).toContain("Jordan Rivera");
  });
  it("shown: as before", () => {
    expect(buildContactReassignmentEmail({ ...base, contactEmail: ADDRESS }).html).toContain(`mailto:${ADDRESS}`);
  });
});
