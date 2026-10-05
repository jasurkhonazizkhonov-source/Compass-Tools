import { describe, it, expect } from "vitest";
import { toEmailSegments } from "../segment-mapper";
import { buildQuoteEmail, buildBookingConfirmationEmail, buildCancellationScheduledEmail, buildCancellationConfirmedEmail, buildBookingProfitNotificationEmail } from "../templates";
import type { ResolvedCompanyBranding } from "@/lib/company-config";

// Airlines added or corrected by the airline reference-data refresh must render with the right name and logo in every
// customer/internal email that shows an itinerary: quote, booking confirmation, exchange, cancellation. An airline the
// logo CDN has no image for must fall back to its name alone — never a broken or blank <img>.

const COMPANY: ResolvedCompanyBranding = {
  id: "c",
  name: "Test Travel Co",
  website: "https://test.example.com",
  phone: "+1 555 000 0000",
  brandColor: "#1c3a5e",
  logoEmailUrl: "https://test.example.com/logo-email.png",
  logoWebUrl: "https://test.example.com/logo-web.png",
  logoIconUrl: "https://test.example.com/logo-icon.png",
  signatureTemplate: "Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}",
};

type Raw = Parameters<typeof toEmailSegments>[0][number];
const seg = (airline: { name: string; iata: string; icao: string }): Raw => ({
  id: "seg-1",
  flightNumber: "123",
  bookingClass: "Y",
  cabin: "ECONOMY",
  departureAt: new Date("2026-11-14T09:00:00Z"),
  arrivalAt: new Date("2026-11-14T17:20:00Z"),
  durationMinutes: 320,
  airlineCodeRaw: airline.iata,
  connectionType: null,
  airline: { ...airline, logoUrl: null },
  aircraftType: null,
  aircraftRaw: null,
  operatingCarrierName: null,
  departureAirport: { iata: "IST", city: "Istanbul" },
  arrivalAirport: { iata: "LHR", city: "London" },
  isExtraLeg: false,
});

const PRICING = { adults: 1, children: 0, infants: 0, adultPrice: 1000, childPrice: 0, infantPrice: 0, taxes: 0, serviceFee: 0, gratuity: 0, total: 1000 };
const logoTag = (iata: string) => `<img src="https://images.kiwi.com/airlines/64x64/${iata}.png"`;

// Representative additions/corrections from every region.
const NEW_AIRLINES = [
  { name: "Pegasus Airlines", iata: "PC", icao: "PGT" }, // recycled code, Europe/Middle East
  { name: "Volotea", iata: "V7", icao: "VOE" }, // low-cost Europe
  { name: "Starlux Airlines", iata: "JX", icao: "SJX" }, // Asia
  { name: "SpiceJet", iata: "SG", icao: "SEJ" }, // South Asia
  { name: "Azul Brazilian Airlines", iata: "AD", icao: "AZU" }, // Latin America
  { name: "Akasa Air", iata: "QP", icao: "AKJ" },
  { name: "Air Serbia", iata: "JU", icao: "ASL" },
  { name: "Edelweiss Air", iata: "WK", icao: "EDW" },
  { name: "Virgin Australia", iata: "VA", icao: "VOZ" }, // Oceania
  { name: "Air Peace", iata: "P4", icao: "APK" }, // Africa
];

describe.each(NEW_AIRLINES)("$name ($iata) — name and logo in every itinerary email", (airline) => {
  const segs = () => toEmailSegments([seg(airline)]);

  it("customer quote email", () => {
    const { html } = buildQuoteEmail({ customerFirstName: "Andrew", agentFullName: "Jane Doe", tripType: "ONE_WAY", passengerCount: 1, segments: segs(), pricing: PRICING, viewDealUrl: "https://example.com/q/1", company: COMPANY });
    expect(html).toContain(airline.name);
    expect(html).toContain(logoTag(airline.iata));
  });

  it("booking confirmation email, and the same email as an EXCHANGE confirmation", () => {
    const params = {
      customerFirstName: "Andrew",
      bookingReference: "BK-1",
      segments: segs(),
      pricing: PRICING,
      paymentMethods: [],
      paymentPaid: true,
      passengers: [{ firstName: "Andrew", middleName: null, lastName: "Kent", dateOfBirth: null, type: "ADULT" as const }],
      contactName: "Andrew Kent",
      contactEmail: "andrew@example.com",
      contactPhone: "555-1212",
      confirmations: [{ id: "1", airlineName: airline.name, confirmationNumber: "ABC123", eTicketNumbers: [] }],
      company: COMPANY,
    };
    const normal = buildBookingConfirmationEmail(params).html;
    const exchange = buildBookingConfirmationEmail({ ...params, exchange: { exchangeFee: 100, fareDifference: 50, currency: "USD" } }).html;
    for (const html of [normal, exchange]) {
      expect(html).toContain(airline.name);
      expect(html).toContain(logoTag(airline.iata));
      expect(html).toContain("ABC123");
    }
    expect(exchange).toContain("Exchange");
  });

  it("customer cancellation emails (scheduled and confirmed)", () => {
    const s = segs();
    const scheduled = buildCancellationScheduledEmail({ customerFirstName: "Andrew", agentFullName: "Jane Doe", segments: s, cancelledSegmentIds: new Set([s[0].id!]), viewDealUrl: "https://example.com/q/1", company: COMPANY }).html;
    const confirmed = buildCancellationConfirmedEmail({ customerFirstName: "Andrew", agentFullName: "Jane Doe", segments: s, cancelledSegmentIds: new Set([s[0].id!]), company: COMPANY }).html;
    for (const html of [scheduled, confirmed]) {
      expect(html).toContain(airline.name);
      expect(html).toContain(logoTag(airline.iata));
    }
  });

  it("internal new-sale / exchange / cancellation notifications", () => {
    const base = { agentFullName: "Nigora Dadabaeva", agentRole: "Travel Agent", agentLocation: "Frankfurt", hireAgeCompact: "0Y0M11D", profit: 287, destination: "London, United Kingdom", currency: "USD" as const, bookingReference: "BK-3921", passengerCount: 2, ticketBookingCost: 3800, sellingCost: 4087, company: COMPANY, segments: segs() };
    for (const label of [undefined, "EXCHANGE" as const, "CANCELLATION" as const]) {
      const { html } = buildBookingProfitNotificationEmail({ ...base, transactionLabel: label });
      expect(html).toContain(airline.name);
      expect(html).toContain(logoTag(airline.iata));
    }
  });
});

describe("an airline the logo CDN has no image for", () => {
  const breeze = { name: "Breeze Airways", iata: "MX", icao: "MXY" };

  it("shows its name and flight number with NO <img> (no broken or blank image) in the quote and confirmation emails", () => {
    const segs = toEmailSegments([seg(breeze)]);
    const quote = buildQuoteEmail({ customerFirstName: "Andrew", agentFullName: "Jane Doe", tripType: "ONE_WAY", passengerCount: 1, segments: segs, pricing: PRICING, viewDealUrl: "https://example.com/q/1", company: COMPANY }).html;
    expect(quote).toContain("Breeze Airways");
    expect(quote).toContain("MX 123");
    expect(quote).not.toContain("images.kiwi.com/airlines/64x64/MX.png");
    expect(quote).not.toContain("undefined");
    expect(quote).not.toContain(">null<");
  });
});
