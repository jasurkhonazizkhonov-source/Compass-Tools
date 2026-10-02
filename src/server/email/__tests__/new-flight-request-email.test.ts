import { describe, it, expect } from "vitest";
import { buildNewFlightRequestEmail, buildSequenceEmail, type NewFlightRequestEmailParams } from "../templates";
import type { ResolvedCompanyBranding } from "@/lib/company-config";

const COMPANY: ResolvedCompanyBranding = {
  id: "co-1",
  name: "Test Travel Co",
  website: "https://test.example.com",
  phone: "+1 555 000 0000",
  brandColor: "#1c3a5e",
  logoEmailUrl: "https://test.example.com/logo-email.png",
  logoWebUrl: "https://test.example.com/logo-web.png",
  logoIconUrl: "https://test.example.com/logo-icon.png",
  signatureTemplate: "Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}",
};

const LAX = { iata: "LAX", name: "Los Angeles International Airport", city: "Los Angeles", country: "United States" };
const CDG = { iata: "CDG", name: "Charles de Gaulle Airport", city: "Paris", country: "France" };

const FULL: NewFlightRequestEmailParams = {
  company: COMPANY,
  customerFullName: "Jordan Q. Rivera",
  customerEmail: "jordan@example.com",
  customerPhone: "+14155550123",
  customerPhoneDisplay: "+1 415 555 0123",
  customerCountry: "United States",
  tripType: "ROUND_TRIP",
  cabinClass: "BUSINESS",
  adults: 2,
  children: 1,
  infants: 0,
  departureAirport: LAX,
  arrivalAirport: CDG,
  departureDate: new Date("2026-11-03T00:00:00Z"),
  returnDate: new Date("2026-11-17T00:00:00Z"),
  flexibleDates: true,
  preferredAirline: "Air France",
  budget: 4200,
  notes: "Prefer a morning departure.\nTraveling for a conference.",
  submittedAt: new Date("2026-10-01T15:04:00Z"),
  acceptedAt: new Date("2026-10-01T15:05:00Z"),
  acceptedByName: "Andrew Kent",
};

describe("buildNewFlightRequestEmail", () => {
  it("uses a clear 'New Flight Request — <customer>' subject with no internal ids", () => {
    const { subject } = buildNewFlightRequestEmail(FULL);
    expect(subject).toBe("New Flight Request — Jordan Q. Rivera");
  });

  it("includes every captured field: trip, client, itinerary (outbound AND return), notes and submission details", () => {
    const { html } = buildNewFlightRequestEmail(FULL);
    for (const text of [
      "New Flight Request",
      "Trip Summary",
      "Client Information",
      "Flight Itinerary",
      "Notes From The Client",
      "Submission Details",
      "Round trip",
      "Business",
      "2 adults, 1 child",
      "Nov 3, 2026",
      "Nov 17, 2026",
      "Flexible",
      "Air France",
      "$4,200",
      "Jordan Q. Rivera",
      "United States",
      "Website flight request",
      "Andrew Kent",
      // both airports, in full, on BOTH the outbound and the return leg
      "Los Angeles International Airport",
      "Charles de Gaulle Airport",
      "Paris, France",
      "Los Angeles, United States",
      "Outbound",
      "Return",
    ]) {
      expect(html, text).toContain(text);
    }
    // notes keep their line breaks
    expect(html).toContain("Prefer a morning departure.<br/>Traveling for a conference.");
    // the route appears once per leg in each direction
    expect((html.match(/>LAX</g) ?? []).length).toBe(2);
    expect((html.match(/>CDG</g) ?? []).length).toBe(2);
  });

  it("makes the email and phone actionable (mailto:/tel:) and offers Reply and Call buttons", () => {
    const { html } = buildNewFlightRequestEmail(FULL);
    expect(html).toContain('href="mailto:jordan@example.com"');
    expect(html).toContain('href="tel:+14155550123"');
    expect(html).toMatch(/href="mailto:jordan@example\.com\?subject=[^"]+"[^>]*>Reply to Client</);
    expect(html).toContain(">Call Client<");
  });

  it("renders the company's configured logo through the shared shell", () => {
    const { html } = buildNewFlightRequestEmail(FULL);
    expect(html).toContain(COMPANY.logoEmailUrl!);
    expect(html).toContain(`alt="${COMPANY.name}"`);
  });

  it("falls back to the company name (no broken image) when no logo is configured", () => {
    const { html } = buildNewFlightRequestEmail({ ...FULL, company: { ...COMPANY, logoEmailUrl: null } });
    expect(html).not.toContain("<img");
    expect(html).toContain("Test Travel Co");
  });

  it("omits optional sections entirely rather than fabricating values", () => {
    const { html } = buildNewFlightRequestEmail({
      ...FULL,
      customerEmail: null,
      customerPhone: null,
      customerPhoneDisplay: null,
      customerCountry: null,
      tripType: "ONE_WAY",
      returnDate: null,
      flexibleDates: false,
      preferredAirline: null,
      budget: null,
      notes: null,
    });
    for (const text of ["Notes From The Client", "Reply to Client", "Call Client", "mailto:", "tel:", "Flexible", "Preferred airline", "Approximate budget", "Return date", "Country", ">Return<", "undefined", "null"]) {
      expect(html, text).not.toContain(text);
    }
    expect(html).toContain("One way");
    expect(html).toContain("Flight Itinerary");
  });

  it("handles a request with no airports captured without breaking or showing 'undefined'", () => {
    const { html } = buildNewFlightRequestEmail({ ...FULL, departureAirport: null, arrivalAirport: null, tripType: "ONE_WAY", returnDate: null });
    expect(html).toContain("Not specified");
    expect(html).not.toContain("undefined");
  });

  it("flags a multi-city request as capturing only one route instead of pretending more legs exist", () => {
    const { html } = buildNewFlightRequestEmail({ ...FULL, tripType: "MULTI_CITY", returnDate: null });
    expect(html).toContain("Multi-city request");
    expect((html.match(/>LAX</g) ?? []).length).toBe(1);
  });

  it("escapes customer-controlled text (name, notes, airline) instead of rendering it as markup", () => {
    const { html, subject } = buildNewFlightRequestEmail({
      ...FULL,
      customerFullName: `<script>alert(1)</script> O'Brien`,
      notes: `<img src=x onerror=alert(1)>`,
      preferredAirline: `<b>Evil</b>`,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Evil</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(subject).toContain("O'Brien");
  });

  it("stays layout-safe for very long names, emails and airport names (wrap protection, fixed outer table, stacking rules)", () => {
    const long = "A".repeat(180);
    const { html } = buildNewFlightRequestEmail({
      ...FULL,
      customerFullName: long,
      customerEmail: `${"b".repeat(90)}@${"c".repeat(60)}.example.com`,
      departureAirport: { ...LAX, name: "N".repeat(150) },
    });
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("table-layout:fixed");
    expect(html).toContain(".ct-kv-label");
    expect(html).toContain('<meta name="viewport"');
  });

  it("never exposes database ids, payment data or internal secrets", () => {
    const { html, subject } = buildNewFlightRequestEmail(FULL);
    const all = `${subject}\n${html}`;
    expect(all).not.toMatch(/\bc[a-z0-9]{24}\b/); // cuid-shaped id
    expect(all).not.toMatch(/\b(?:\d[ -]?){13,19}\b/); // card-number-shaped
    expect(all).not.toMatch(/cvv|cvc|password|token|secret|encrypted/i);
    expect(all).not.toMatch(/\/leads\/|\/bookings\/|\/quote\//);
  });

  it("states it is internal — it must never read like a customer email", () => {
    const { html } = buildNewFlightRequestEmail(FULL);
    expect(html).toContain("not sent to the customer");
  });
});

describe("customer emails and sequences share the same branded shell", () => {
  it("a sequence email renders the company logo header and footer (same shell as quotes/bookings)", () => {
    const { html } = buildSequenceEmail({ subject: "Following up", bodyText: "Hello Jordan\n\nJust checking in.", company: COMPANY });
    expect(html).toContain(COMPANY.logoEmailUrl!);
    expect(html).toContain("test.example.com");
    expect(html).toContain('<meta name="viewport"');
  });
});

describe("multi-city requests — every captured segment is shown", () => {
  const SEGMENTS = [
    { departureAirport: { iata: "JFK", name: "John F. Kennedy International Airport", city: "New York", country: "United States" }, arrivalAirport: { iata: "LHR", name: "Heathrow Airport", city: "London", country: "United Kingdom" }, departureDate: new Date("2026-10-20T00:00:00Z") },
    { departureAirport: { iata: "LHR", name: "Heathrow Airport", city: "London", country: "United Kingdom" }, arrivalAirport: { iata: "CDG", name: "Charles de Gaulle Airport", city: "Paris", country: "France" }, departureDate: new Date("2026-10-24T00:00:00Z") },
    { departureAirport: { iata: "CDG", name: "Charles de Gaulle Airport", city: "Paris", country: "France" }, arrivalAirport: { iata: "JFK", name: "John F. Kennedy International Airport", city: "New York", country: "United States" }, departureDate: new Date("2026-10-30T00:00:00Z") },
  ];

  it("renders Segment 1, 2 and 3 in order with their dates — not collapsed into one route", () => {
    const { html } = buildNewFlightRequestEmail({ ...FULL, tripType: "MULTI_CITY", returnDate: null, segments: SEGMENTS });
    for (const text of ["Segment 1", "Segment 2", "Segment 3", "Oct 20, 2026", "Oct 24, 2026", "Oct 30, 2026", "Heathrow Airport", "Charles de Gaulle Airport"]) {
      expect(html, text).toContain(text);
    }
    expect(html.indexOf("Segment 1")).toBeLessThan(html.indexOf("Segment 2"));
    expect(html.indexOf("Segment 2")).toBeLessThan(html.indexOf("Segment 3"));
    expect(html).not.toContain("only one route was captured");
    expect(html).not.toContain(">Return<");
  });

  it("a multi-city request with no saved segments keeps the honest one-route note", () => {
    const { html } = buildNewFlightRequestEmail({ ...FULL, tripType: "MULTI_CITY", returnDate: null, segments: [] });
    expect(html).toContain("only one route was captured");
  });

  it("segments on a lead that is no longer multi-city are ignored (round trip still shows Outbound and Return)", () => {
    const { html } = buildNewFlightRequestEmail({ ...FULL, tripType: "ROUND_TRIP", segments: SEGMENTS });
    expect(html).toContain("Outbound");
    expect(html).toContain("Return");
    expect(html).not.toContain("Segment 1");
  });

  it("the lead-reassigned-to-you email shows all segments too (same shared itinerary block)", async () => {
    const { buildLeadReassignmentEmail } = await import("../templates");
    const { html } = buildLeadReassignmentEmail({
      ...FULL,
      tripType: "MULTI_CITY",
      returnDate: null,
      segments: SEGMENTS,
      direction: "TO_YOU",
      recipientFullName: "Andrew Kent",
      status: "QUOTED",
      source: "WEBSITE",
      newOwnerName: "Andrew Kent",
      previousOwnerName: "Nigora",
      reassignedByName: "Sarah",
      reassignedAt: new Date("2026-10-02T12:51:00Z"),
      reason: null,
      leadUrl: null,
    });
    expect(html).toContain("Segment 3");
  });
});
