// GDS-adversarial-input audit — end-to-end proof that a hostile string
// originating from a pasted GDS "OPERATED BY X" continuation line (the one
// genuinely free-text field the Sabre/Apollo parsers produce — see
// src/lib/parsers/gds-line.ts's OPERATED_BY_RE and
// src/lib/parsers/__tests__/adversarial-input.test.ts) can never reach a
// customer- or agent-facing email as live HTML/script. Every other parsed
// field (airline code, flight number, booking class, airport code, aircraft
// code) is already constrained to a narrow safe character set by the
// parser's own regexes, so operatingCarrierName is the realistic target for
// this class of injection.
//
// Exercises the real pipeline: parseGdsItinerary -> toEmailSegments (the
// same mapper used by every real email send) -> buildQuoteEmail, rather
// than constructing an EmailSegment by hand, so this fails if any layer in
// between stops escaping.
import { describe, it, expect } from "vitest";
import { parseGdsItinerary } from "@/lib/parsers/gds-line";
import { toEmailSegments } from "../segment-mapper";
import { buildQuoteEmail, type EmailPricing } from "../templates";
import type { ResolvedCompanyBranding } from "@/lib/company-config";

const TEST_COMPANY: ResolvedCompanyBranding = {
  id: "test-company",
  name: "Test Travel Co",
  website: "https://test.example.com",
  phone: "+1 555 000 0000",
  brandColor: "#1c3a5e",
  logoEmailUrl: null,
  logoWebUrl: "https://test.example.com/logo-web.png",
  logoIconUrl: "https://test.example.com/logo-icon.png",
  signatureTemplate: "Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}",
};

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

function segmentFromParsedItinerary(text: string) {
  const [parsed] = parseGdsItinerary(text, 2026);
  const [segment] = toEmailSegments([
    {
      flightNumber: parsed.flightNumber ?? "100",
      bookingClass: parsed.bookingClass ?? null,
      cabin: "ECONOMY",
      departureAt: new Date("2026-08-27T14:00:00Z"),
      arrivalAt: new Date("2026-08-27T16:00:00Z"),
      durationMinutes: 120,
      airlineCodeRaw: parsed.airlineCode ?? null,
      connectionType: null,
      airline: null,
      aircraftType: null,
      aircraftRaw: null,
      operatingCarrierName: parsed.operatingCarrierName ?? null,
      departureAirport: { iata: "JFK", city: "New York" },
      arrivalAirport: { iata: "LAX", city: "Los Angeles" },
      isExtraLeg: false,
    },
  ]);
  return segment;
}

function buildEmailHtml(operatingCarrierRaw: string): string {
  const text = `1 PR2849Z 30JAN MNLCEB SS1 850A 1010A * SA E 1
        OPERATED BY ${operatingCarrierRaw}`;
  const segment = segmentFromParsedItinerary(text);
  const { html } = buildQuoteEmail({
    customerFirstName: "Andrew",
    customerLastName: "Kent",
    agentFullName: "Jane Doe",
    tripType: "ONE_WAY",
    passengerCount: 1,
    segments: [segment],
    pricing: PRICING,
    viewDealUrl: "https://test.example.com/quote/some-token",
    company: TEST_COMPANY,
  });
  return html;
}

describe("GDS-parsed operating-carrier text is HTML-escaped before reaching a customer email", () => {
  it("a <script> payload in the OPERATED BY line never appears as a live tag in the email HTML", () => {
    const html = buildEmailHtml("<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("an <img onerror=...> payload never appears as a live tag in the email HTML", () => {
    const html = buildEmailHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("an attribute-breakout attempt (quote + tag) is neutralized", () => {
    const html = buildEmailHtml('PAL"><script>alert(2)</script>');
    expect(html).not.toContain('"><script>alert(2)</script>');
    expect(html).not.toContain("<script>alert(2)</script>");
  });

  it("a plain, non-adversarial operating-carrier name still renders normally", () => {
    const html = buildEmailHtml("PAL EXPRESS");
    expect(html).toContain("Operated by PAL EXPRESS");
  });
});
