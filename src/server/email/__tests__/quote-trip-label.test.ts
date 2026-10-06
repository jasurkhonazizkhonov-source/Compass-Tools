import { describe, it, expect } from "vitest";
import { toEmailSegments } from "../segment-mapper";
import { buildQuoteEmail } from "../templates";
import type { ResolvedCompanyBranding } from "@/lib/company-config";

// The customer-facing Trip Summary shows the trip type as words ("Round trip"), never as the stored enum ("ROUND_TRIP" / "ROUND TRIP").
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
const SEGMENTS = toEmailSegments([
  {
    id: "s1",
    flightNumber: "123",
    bookingClass: "Y",
    cabin: "ECONOMY",
    departureAt: new Date("2026-11-14T09:00:00Z"),
    arrivalAt: new Date("2026-11-14T17:20:00Z"),
    durationMinutes: 320,
    airlineCodeRaw: "LH",
    connectionType: null,
    airline: { name: "Lufthansa", iata: "LH", icao: "DLH", logoUrl: null },
    aircraftType: null,
    aircraftRaw: null,
    operatingCarrierName: null,
    departureAirport: { iata: "IST", city: "Istanbul" },
    arrivalAirport: { iata: "LHR", city: "London" },
    isExtraLeg: false,
  },
]);
const PRICING = { adults: 1, children: 0, infants: 0, adultPrice: 1000, childPrice: 0, infantPrice: 0, taxes: 0, serviceFee: 0, gratuity: 0, total: 1000 };
const html = (tripType: string) =>
  buildQuoteEmail({ customerFirstName: "Andrew", agentFullName: "Jane Doe", tripType, passengerCount: 2, segments: SEGMENTS, pricing: PRICING, viewDealUrl: "https://example.com/q/1", company: COMPANY }).html;

describe("quote email Trip Summary", () => {
  it.each([
    ["ROUND_TRIP", "Round trip"],
    ["ROUND TRIP", "Round trip"],
    ["ONE_WAY", "One way"],
    ["ONE WAY", "One way"],
    ["MULTI_CITY", "Multi-city"],
  ])("%s is shown as %s", (stored, label) => {
    const out = html(stored);
    expect(out).toContain(`${label} · 2 passengers`);
    expect(out).not.toMatch(/ROUND[_ ]TRIP|ONE[_ ]WAY|MULTI[_ ]CITY/);
  });
});
