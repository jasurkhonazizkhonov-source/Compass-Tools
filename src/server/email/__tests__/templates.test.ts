import { describe, it, expect } from "vitest";
import {
  buildSequenceEmail,
  buildQuoteEmail,
  buildBookingProfitNotificationEmail,
  buildBookingConfirmationEmail,
  buildCancellationScheduledEmail,
  buildCancellationConfirmedEmail,
  buildCvvRecollectionEmail,
  buildBookingSignedNotificationEmail,
  buildMarketingCampaignEmail,
  renderPricingHtml,
  type EmailSegment,
  type EmailPricing,
} from "../templates";
import { toAirportDateTime } from "@/lib/airport-datetime";
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

describe("signature resolution — Company.signatureTemplate", () => {
  it("resolves {{first_name}}/{{last_name}}/{{phone_number}} against the actual sending agent, not stored/static text", () => {
    const { html } = buildSequenceEmail({
      subject: "Hi",
      bodyText: "Body text.",
      company: TEST_COMPANY,
      agent: { fullName: "Jane Doe", email: "jane@example.com", phone: "555-1212" },
    });
    expect(html).toContain("Jane Doe");
    expect(html).toContain("555-1212");
  });

  it("re-resolves per sending agent — two different agents produce two different signatures from the same template", () => {
    const janeHtml = buildSequenceEmail({
      subject: "Hi",
      bodyText: "Body text.",
      company: TEST_COMPANY,
      agent: { fullName: "Jane Doe", email: "jane@example.com", phone: "555-1212" },
    }).html;
    const johnHtml = buildSequenceEmail({
      subject: "Hi",
      bodyText: "Body text.",
      company: TEST_COMPANY,
      agent: { fullName: "John Smith", email: "john@example.com", phone: "555-3434" },
    }).html;
    expect(janeHtml).toContain("Jane Doe");
    expect(janeHtml).not.toContain("John Smith");
    expect(johnHtml).toContain("John Smith");
    expect(johnHtml).not.toContain("Jane Doe");
  });

  it("falls back to the company's own name/phone when there is no personal sender (system-generated email)", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "Body text.", company: TEST_COMPANY });
    expect(html).toContain(TEST_COMPANY.name);
    expect(html).toContain(TEST_COMPANY.phone!);
  });

  it("an admin editing the template changes the rendered signature immediately — no per-user stored copy", () => {
    const customCompany: ResolvedCompanyBranding = { ...TEST_COMPANY, signatureTemplate: "Warm regards,\n{{first_name}}\nDirect: {{phone_number}}" };
    const { html } = buildSequenceEmail({
      subject: "Hi",
      bodyText: "Body text.",
      company: customCompany,
      agent: { fullName: "Jane Doe", email: "jane@example.com", phone: "555-1212" },
    });
    expect(html).toContain("Warm regards");
    expect(html).toContain("Direct: 555-1212");
    expect(html).not.toContain("Best regards");
  });
});

// Pass 15 §18/§19 — the shared card chrome every email routes through
// (renderEmailCard, exercised indirectly here via buildSequenceEmail) was
// previously a bare HTML fragment with no <!DOCTYPE>/<head>/viewport meta,
// and its outer single-column table had no table-layout, both of which
// were found live (Browser pane, a real HTTP-served 375px render) to let a
// realistic long company website domain force the whole card wider than
// the viewport. These are string-level regression tests for the fix's
// presence — they cannot themselves prove no browser lays it out
// differently, but they pin the exact HTML properties that fix relies on
// so a future edit can't silently drop them again.
describe("shared email shell — document structure & mobile safety (Pass 15 §18/§19)", () => {
  it("emits a real HTML5 document with a mobile viewport meta tag", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "Body text.", company: TEST_COMPANY });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />');
  });

  it("the outer card table is table-layout:fixed, so one long unbreakable word can't inflate it past the viewport", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "Body text.", company: TEST_COMPANY });
    expect(html).toContain("table-layout:fixed;");
  });

  it("a long company website domain in the footer/signature never renders as an unbroken string with no wrap protection", () => {
    const longDomainCompany: ResolvedCompanyBranding = { ...TEST_COMPANY, website: "https://businessflightstravelagencyinternational.example.com" };
    const { html } = buildSequenceEmail({
      subject: "Hi",
      bodyText: "Body text.",
      company: longDomainCompany,
      agent: { fullName: "Jane Doe", email: "jane@example.com", phone: "555-1212" },
    });
    // Every rendered <a> wrapping the raw domain text must carry wrap
    // protection — regex avoids over-fitting to one exact style string.
    const anchorsWithDomain = [...html.matchAll(/<a[^>]*>businessflightstravelagencyinternational\.example\.com<\/a>/g)];
    expect(anchorsWithDomain.length).toBeGreaterThan(0);
    for (const match of anchorsWithDomain) {
      expect(match[0]).toMatch(/word-break:break-all|overflow-wrap:anywhere/);
    }
  });
});

describe("buildSequenceEmail", () => {
  it("renders the subject through unchanged", () => {
    const { subject } = buildSequenceEmail({ subject: "Your flight booking for John", bodyText: "Hi John,", company: TEST_COMPANY });
    expect(subject).toBe("Your flight booking for John");
  });

  it("wraps the body in the branded HTML layout, not raw text", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "Hi John,\n\nThanks for reaching out.", company: TEST_COMPANY });
    expect(html).toContain(TEST_COMPANY.name);
    expect(html).toContain("<table");
    expect(html).not.toBe("Hi John,\n\nThanks for reaching out.");
  });

  it("splits on blank lines into separate paragraphs", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "First paragraph.\n\nSecond paragraph.", company: TEST_COMPANY });
    const paragraphCount = (html.match(/<p /g) || []).length;
    expect(paragraphCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain("First paragraph.");
    expect(html).toContain("Second paragraph.");
  });

  it("preserves single line breaks within one paragraph", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "Line one\nLine two", company: TEST_COMPANY });
    expect(html).toContain("Line one<br/>Line two");
  });

  it("escapes HTML special characters instead of interpreting them as markup", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "Use code <b>BOOK10</b> for 10% off", company: TEST_COMPANY });
    expect(html).toContain("&lt;b&gt;BOOK10&lt;/b&gt;");
    expect(html).not.toContain("<b>BOOK10</b>");
  });

  it("linkifies a bare URL into a clickable, styled anchor", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "View your quote: https://example.com/quote/abc123", company: TEST_COMPANY });
    expect(html).toContain('<a href="https://example.com/quote/abc123"');
  });

  it("drops empty paragraphs from extra blank lines without erroring", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "Para one.\n\n\n\nPara two.", company: TEST_COMPANY });
    expect(html).toContain("Para one.");
    expect(html).toContain("Para two.");
  });

  it("never mentions the internal CRM name for sequence emails", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "Just checking in about your trip.", company: TEST_COMPANY });
    expect(html).not.toContain("Compass Tools");
  });

  // Pass 16 §4/§5 — a deliberate, one-off, human-authored email (the Lead/
  // Contact composer, Get in Touch replies) must NEVER carry an
  // unsubscribe link; only the unattended automated drip send
  // (processDueSequenceSteps) passes unsubscribeUrl. Both directions
  // regression-tested so neither can silently start/stop happening.
  it("renders NO unsubscribe link when unsubscribeUrl is omitted (the one-off composer path)", () => {
    const { html } = buildSequenceEmail({ subject: "Hi", bodyText: "Just checking in.", company: TEST_COMPANY });
    expect(html).not.toContain("Unsubscribe");
  });

  it("renders a working unsubscribe link when unsubscribeUrl is provided (the automated drip path)", () => {
    const { html } = buildSequenceEmail({
      subject: "Hi",
      bodyText: "Just checking in.",
      company: TEST_COMPANY,
      unsubscribeUrl: "https://example.com/api/public/sequence-unsubscribe?enrollment=enr-123",
    });
    expect(html).toContain('href="https://example.com/api/public/sequence-unsubscribe?enrollment=enr-123"');
    expect(html).toContain("Unsubscribe");
  });
});

// Regression suite for the customer-facing itinerary-time bug: the email
// previously rendered flight times several hours off from what the
// itinerary builder / CRM / View Deal showed for the exact same saved
// segment, because the email formatter forced UTC while the write path
// interpreted the naive datetime string as the server's ambient local
// timezone (see src/lib/airport-datetime.ts's header comment for the full
// root-cause explanation). This suite builds segments the same way
// quotes.ts does (via toAirportDateTime, the corrected write-path
// function) and asserts the rendered HTML contains the exact expected
// wall-clock strings — not a normalized/formatted comparison, the literal
// substrings a customer would read in their inbox.
function makeSegment(overrides: Partial<EmailSegment>): EmailSegment {
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
    departureAt: toAirportDateTime("2026-08-27", "00:00"),
    arrivalAt: toAirportDateTime("2026-08-27", "01:00"),
    durationMinutes: 60,
    connectionType: null,
    isExtraLeg: false,
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
  taxes: 0,
  serviceFee: 0,
  gratuity: 0,
  total: 1000,
};

// Multi-currency quote sending (§24-27): the price breakdown is rendered
// with a currency-specific symbol taken from the already-converted
// EmailPricing values, never a hardcoded "$" — see Quote.pricingSnapshot /
// buildPricingSnapshot for where the conversion itself happens.
describe("renderPricingHtml — currency symbol", () => {
  it("defaults to a USD $ sign when no currency is given (backward compatible)", () => {
    const html = renderPricingHtml(PRICING);
    expect(html).toContain("$1,000.00");
  });

  it("uses the € symbol for EUR", () => {
    const html = renderPricingHtml({ ...PRICING, currency: "EUR", total: 920 });
    expect(html).toContain("€920.00");
    expect(html).not.toContain("$920.00");
  });

  it("uses the £ symbol for GBP", () => {
    const html = renderPricingHtml({ ...PRICING, currency: "GBP", total: 790 });
    expect(html).toContain("£790.00");
  });

  it("uses C$ for CAD and A$ for AUD, applied to every line not just the total", () => {
    const cadHtml = renderPricingHtml({ ...PRICING, currency: "CAD", adultPrice: 1360, total: 1360 });
    expect(cadHtml).toContain("C$1,360.00");
    const audHtml = renderPricingHtml({ ...PRICING, currency: "AUD", adultPrice: 1520, total: 1520 });
    expect(audHtml).toContain("A$1,520.00");
  });
});

describe("buildQuoteEmail — itinerary time regression (exact reported bug example)", () => {
  it("MCO -> PHL: renders 2:09 PM departure and 4:47 PM arrival, not a UTC-shifted value", () => {
    const segment = makeSegment({
      departureAirportCode: "MCO",
      departureCity: "Orlando",
      arrivalAirportCode: "PHL",
      arrivalCity: "Philadelphia",
      departureAt: toAirportDateTime("2026-08-27", "14:09"),
      arrivalAt: toAirportDateTime("2026-08-27", "16:47"),
    });
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [segment],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).toContain("2:09 PM");
    expect(html).toContain("4:47 PM");
    expect(html).not.toContain("9:09 PM");
    expect(html).not.toContain("11:47 PM");
  });

  it("PHL -> DOH: renders 9:30 PM departure and 5:25 PM (+1 day) arrival, not the previously-reported 4:30 AM / 12:25 AM shift", () => {
    const segment = makeSegment({
      departureAirportCode: "PHL",
      departureCity: "Philadelphia",
      arrivalAirportCode: "DOH",
      arrivalCity: "Doha",
      departureAt: toAirportDateTime("2026-08-27", "21:30"),
      arrivalAt: toAirportDateTime("2026-08-28", "17:25"),
    });
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [segment],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).toContain("9:30 PM");
    expect(html).toContain("5:25 PM");
    expect(html).toContain("(+1 day)");
    expect(html).not.toContain("4:30 AM");
    expect(html).not.toContain("12:25 AM");
  });

  it("DOH -> NBO: renders 6:45 PM departure and 11:50 PM arrival, not the previously-reported 1:45 AM / 6:50 AM shift", () => {
    const segment = makeSegment({
      departureAirportCode: "DOH",
      departureCity: "Doha",
      arrivalAirportCode: "NBO",
      arrivalCity: "Nairobi",
      departureAt: toAirportDateTime("2026-08-28", "18:45"),
      arrivalAt: toAirportDateTime("2026-08-28", "23:50"),
    });
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [segment],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).toContain("6:45 PM");
    expect(html).toContain("11:50 PM");
    expect(html).not.toContain("1:45 AM");
    expect(html).not.toContain("6:50 AM");
  });

  it("full round-trip itinerary: every leg's rendered email time exactly matches its constructed wall-clock value", () => {
    const legs: Array<{ dep: [string, string]; arr: [string, string]; depExpected: string; arrExpected: string }> = [
      { dep: ["2026-08-27", "14:09"], arr: ["2026-08-27", "16:47"], depExpected: "2:09 PM", arrExpected: "4:47 PM" },
      { dep: ["2026-08-27", "21:30"], arr: ["2026-08-28", "17:25"], depExpected: "9:30 PM", arrExpected: "5:25 PM" },
      { dep: ["2026-08-28", "18:45"], arr: ["2026-08-28", "23:50"], depExpected: "6:45 PM", arrExpected: "11:50 PM" },
      { dep: ["2026-09-05", "01:20"], arr: ["2026-09-05", "06:25"], depExpected: "1:20 AM", arrExpected: "6:25 AM" },
      { dep: ["2026-09-05", "08:25"], arr: ["2026-09-05", "16:40"], depExpected: "8:25 AM", arrExpected: "4:40 PM" },
      { dep: ["2026-09-05", "19:40"], arr: ["2026-09-05", "21:03"], depExpected: "7:40 PM", arrExpected: "9:03 PM" },
    ];
    const segments = legs.map((leg, i) =>
      makeSegment({
        flightNumber: String(100 + i),
        departureAt: toAirportDateTime(...leg.dep),
        arrivalAt: toAirportDateTime(...leg.arr),
        connectionType: i > 0 ? "LAYOVER" : null,
      })
    );
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "MULTI_CITY",
      passengerCount: 1,
      segments,
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    for (const leg of legs) {
      expect(html).toContain(leg.depExpected);
      expect(html).toContain(leg.arrExpected);
    }
  });
});

// Pass 11 Part 2 — the shared Total Journey Summary/Connection/Nonstop/
// Flight duration rendering added to renderItineraryHtml, exercised
// through the real buildQuoteEmail entry point (the same function every
// customer quote email is actually built with).
describe("buildQuoteEmail — Total Journey Summary & duration terminology (Pass 11 Part 2)", () => {
  it("Outbound ATL -> CPH -> LHR: renders the exact spec worked example — 15h 30m total journey time, 8h 45m and 2h 0m Flight duration, 4h 45m Connection layover, never 20h 15m", () => {
    const segments: EmailSegment[] = [
      makeSegment({
        flightNumber: "930",
        departureAirportCode: "ATL",
        departureCity: "Atlanta",
        arrivalAirportCode: "CPH",
        arrivalCity: "Copenhagen",
        departureAt: toAirportDateTime("2026-10-13", "19:30"),
        departureTimezone: "America/New_York",
        arrivalAt: toAirportDateTime("2026-10-14", "10:15"),
        arrivalTimezone: "Europe/Copenhagen",
        durationMinutes: 8 * 60 + 45,
        connectionType: null,
      }),
      makeSegment({
        flightNumber: "505",
        departureAirportCode: "CPH",
        departureCity: "Copenhagen",
        arrivalAirportCode: "LHR",
        arrivalCity: "London",
        departureAt: toAirportDateTime("2026-10-14", "15:00"),
        departureTimezone: "Europe/Copenhagen",
        arrivalAt: toAirportDateTime("2026-10-14", "16:00"),
        arrivalTimezone: "Europe/London",
        durationMinutes: 2 * 60,
        connectionType: "LAYOVER",
      }),
    ];

    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments,
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });

    expect(html).toContain("15h 30m");
    expect(html).toContain("total journey time");
    expect(html).toContain("1 connection");
    expect(html).toContain("Copenhagen");
    expect(html).not.toContain("20h 15m"); // must never double-count the connection

    expect(html).toContain("Flight duration");
    expect(html).toContain("8h 45m");
    expect(html).toContain("2h 0m");
    expect(html).toContain("Connection");
    expect(html).toContain("4h 45m layover");

    expect(html).toContain("Atlanta (ATL)");
    expect(html).toContain("London (LHR)");
  });

  it("a nonstop itinerary shows a Nonstop badge and never a fabricated Connection block", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment({})],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).toContain("Nonstop");
    expect(html).not.toContain("Connection —");
  });

  it("a connecting itinerary's Total Journey Summary is NOT just the first flight's own duration", () => {
    const segments: EmailSegment[] = [
      makeSegment({
        flightNumber: "1",
        departureAt: toAirportDateTime("2026-06-01", "08:00"),
        departureTimezone: "America/New_York",
        arrivalAt: toAirportDateTime("2026-06-01", "10:00"),
        arrivalTimezone: "America/New_York",
        durationMinutes: 120,
        connectionType: null,
      }),
      makeSegment({
        flightNumber: "2",
        departureAt: toAirportDateTime("2026-06-01", "11:00"),
        departureTimezone: "America/New_York",
        arrivalAt: toAirportDateTime("2026-06-01", "13:00"),
        arrivalTimezone: "America/New_York",
        durationMinutes: 120,
        connectionType: "LAYOVER",
      }),
    ];
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments,
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    // First flight alone is 2h; the whole journey (2h + 1h connection + 2h) is 5h — must show 5h, not just 2h.
    expect(html).toContain("5h 0m");
  });
});

describe("buildBookingProfitNotificationEmail — subject format", () => {
  const BASE = {
    agentFullName: "Nigora Dadabaeva",
    agentRole: "Travel Agent" as string | null | undefined,
    agentLocation: "Frankfurt" as string | null,
    hireAgeCompact: "0Y0M11D" as string | null,
    profit: 287,
    destination: "Minneapolis, United States",
    currency: "USD" as const,
    bookingReference: "BFT-TEST",
    passengerCount: 1,
    ticketBookingCost: 4700,
    sellingCost: 5265,
    segments: [makeSegment({})],
    company: TEST_COMPANY,
  };

  // Pass 13 §9-§11 — exact required format, verbatim, NO role parenthetical
  // (a prior version of this subject wrongly included one — this is the
  // exact bug this pass's notification-reliability audit found and fixed,
  // and these tests now pin the corrected format rather than the old
  // buggy one): "{Agent} ({location}, hire age: {age}) made
  // {symbol}{profit} to {city}, {country}", with an " on Exchange"/
  // " on Cancellation" suffix for those transaction types.
  it("New Sale: matches the exact required format — no role parenthetical anywhere", () => {
    const { subject } = buildBookingProfitNotificationEmail(BASE);
    expect(subject).toBe("Nigora Dadabaeva (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States");
  });

  it("the agent's role is never present in the subject, whether known or not", () => {
    const withRole = buildBookingProfitNotificationEmail(BASE);
    const withoutRole = buildBookingProfitNotificationEmail({ ...BASE, agentRole: null });
    expect(withRole.subject).toBe(withoutRole.subject);
    expect(withRole.subject).not.toContain("Travel Agent");
  });

  it("omits the hire-age clause but keeps location when hiredAt isn't known", () => {
    const { subject } = buildBookingProfitNotificationEmail({ ...BASE, hireAgeCompact: null });
    expect(subject).toBe("Nigora Dadabaeva (Frankfurt) made $287.00 to Minneapolis, United States");
  });

  it("omits the whole location/hire-age parenthetical when neither is known, but keeps destination", () => {
    const { subject } = buildBookingProfitNotificationEmail({ ...BASE, agentLocation: null, hireAgeCompact: null });
    expect(subject).toBe("Nigora Dadabaeva made $287.00 to Minneapolis, United States");
  });

  it("Exchange: appends ' on Exchange' as a suffix, distinguishing it from a normal new sale", () => {
    const normal = buildBookingProfitNotificationEmail(BASE);
    const exchange = buildBookingProfitNotificationEmail({ ...BASE, isExchange: true });
    expect(normal.subject).not.toContain("Exchange");
    expect(exchange.subject).toBe("Nigora Dadabaeva (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States on Exchange");
    // Pass 17 §15/§36 — a short at-a-glance category badge, not the full
    // customer-facing "Exchange Booking Confirmed" sentence (that heading
    // belongs to buildBookingConfirmationEmail — a different, customer-
    // facing function this pass deliberately left untouched).
    expect(exchange.html).toContain(">EXCHANGE<");
    expect(normal.html).not.toContain(">EXCHANGE<");
  });

  it("never includes a View Booking button/link — this internal notification carries no direct booking CTA", () => {
    const { html } = buildBookingProfitNotificationEmail(BASE);
    expect(html).not.toContain("View Booking");
  });

  // Pass 24 — a real bug found during re-verification: `${symbol}${fmtMoney(n)}`
  // puts the minus sign on the NUMBER (toLocaleString's own behavior),
  // producing "$-150.00" for a loss-making sale — never the required
  // "-$150.00" (sign before the symbol). Fixed via fmtSignedMoney.
  it("a negative profit (a loss-making sale) formats as '-$150.00', never '$-150.00'", () => {
    const { subject, html } = buildBookingProfitNotificationEmail({ ...BASE, profit: -150 });
    expect(subject).toBe("Nigora Dadabaeva (Frankfurt, hire age: 0Y0M11D) made -$150.00 to Minneapolis, United States");
    expect(subject).not.toContain("$-150.00");
    expect(html).toContain("-$150.00");
    expect(html).not.toContain("$-150.00");
  });

  it("zero profit formats as $0.00, not -$0.00 or a blank amount", () => {
    const { subject } = buildBookingProfitNotificationEmail({ ...BASE, profit: 0 });
    expect(subject).toBe("Nigora Dadabaeva (Frankfurt, hire age: 0Y0M11D) made $0.00 to Minneapolis, United States");
  });

  it("Part 16 — transactionLabel: 'CANCELLATION' appends ' on Cancellation' (exact spelling) as a suffix, distinct from a normal new sale or an exchange", () => {
    const normal = buildBookingProfitNotificationEmail(BASE);
    const cancellation = buildBookingProfitNotificationEmail({ ...BASE, transactionLabel: "CANCELLATION" });
    const exchange = buildBookingProfitNotificationEmail({ ...BASE, transactionLabel: "EXCHANGE" });
    expect(cancellation.subject).toBe("Nigora Dadabaeva (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States on Cancellation");
    expect(cancellation.subject).not.toContain("Cancelation"); // exact spelling — never the common misspelling
    expect(cancellation.html).toContain(">CANCELLATION<");
    expect(cancellation.html).not.toContain(">EXCHANGE<");
    expect(normal.html).not.toContain(">CANCELLATION<");
    // Pass 17 §36 — a cancellation is not a revenue win: its category
    // badge (the border-radius:6px pill at the top, NOT the itinerary's
    // own unrelated "Nonstop" tag, which also happens to use #ecfdf5) must
    // not reuse the same green "success" background every other
    // transaction type gets.
    expect(cancellation.html).not.toContain("background:#ecfdf5; border-radius:6px");
    expect(normal.html).toContain("background:#ecfdf5; border-radius:6px");
    expect(exchange.subject).toBe("Nigora Dadabaeva (Frankfurt, hire age: 0Y0M11D) made $287.00 to Minneapolis, United States on Exchange");
  });

  it("profit is always formatted with exactly two decimal places", () => {
    const whole = buildBookingProfitNotificationEmail({ ...BASE, profit: 287 });
    const fractional = buildBookingProfitNotificationEmail({ ...BASE, profit: 287.5 });
    expect(whole.subject).toContain("$287.00");
    expect(fractional.subject).toContain("$287.50");
  });

  it("Part 16 — transactionLabel takes precedence over the older isExchange flag when both are somehow set", () => {
    const { subject } = buildBookingProfitNotificationEmail({ ...BASE, isExchange: true, transactionLabel: "CANCELLATION" });
    expect(subject).toContain("on Cancellation");
    expect(subject).not.toContain("on Exchange");
  });

  it("never exposes the internal booking reference anywhere in the subject or body — this is an internal-only notification and the reference must never leak, per the exact same rule that applies to customer-facing content", () => {
    const { subject, html } = buildBookingProfitNotificationEmail(BASE);
    expect(subject).not.toContain(BASE.bookingReference);
    expect(html).not.toContain(BASE.bookingReference);
  });

  it("never includes a Quote ID anywhere in the subject or body", () => {
    const { subject, html } = buildBookingProfitNotificationEmail(BASE);
    expect(subject.toLowerCase()).not.toContain("quote");
    expect(html.toLowerCase()).not.toContain("quote id");
  });
});

describe("buildBookingConfirmationEmail — intro wording must match whether tickets are actually issued", () => {
  const BASE_CONFIRMATION = {
    customerFirstName: "Jane",
    bookingReference: "BFT-TEST",
    segments: [makeSegment({})],
    pricing: PRICING,
    paymentMethods: [],
    paymentPaid: true,
    passengers: [],
    contactName: "Jane Doe",
    contactEmail: "jane@example.com",
    contactPhone: "+15551234567",
    confirmations: [] as { id: string; airlineName: string | null; confirmationNumber: string; eTicketNumbers: string[] }[],
    company: TEST_COMPANY,
  };

  it("once tickets are issued, never tells the customer their booking is still being processed", () => {
    const { html } = buildBookingConfirmationEmail({
      ...BASE_CONFIRMATION,
      confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA1234567890", eTicketNumbers: ["0257123456789"] }],
    });
    expect(html).not.toContain("is being processed");
    expect(html).not.toContain("we are working on the ticket issuance");
    expect(html).toContain("Thank you for booking with");
    expect(html).toContain("AA1234567890");
  });

  it("before tickets are issued, still tells the customer issuance is in progress", () => {
    const { html } = buildBookingConfirmationEmail({
      ...BASE_CONFIRMATION,
      confirmations: [],
    });
    expect(html).toContain("is being processed");
    expect(html).toContain("working on your ticket issuance");
  });

  it("never includes PNR or internal notes — buildBookingConfirmationEmail's params have no field for either", () => {
    const { html } = buildBookingConfirmationEmail({
      ...BASE_CONFIRMATION,
      confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA1234567890", eTicketNumbers: ["0257123456789"] }],
    });
    expect(html.toLowerCase()).not.toContain("pnr");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Pass 12 — the shared premium email design system: branded shell,
// preheader, greeting safety, subject-line format, confirmation blocks,
// exchange summary, cancellation headings, and marketing-campaign reuse
// of the SAME shell (no more independently-duplicated chrome).
// ═══════════════════════════════════════════════════════════════════════

const BASE_CONFIRMATION_P12 = {
  customerFirstName: "Jane",
  bookingReference: "BFT-TEST",
  segments: [makeSegment({})],
  pricing: PRICING,
  paymentMethods: [],
  paymentPaid: true,
  passengers: [
    { firstName: "Jane", middleName: null, lastName: "Doe", dateOfBirth: null, type: "ADULT" as const },
    { firstName: "John", middleName: null, lastName: "Doe", dateOfBirth: null, type: "ADULT" as const },
  ],
  contactName: "Jane Doe",
  contactEmail: "jane@example.com",
  contactPhone: "+15551234567",
  company: TEST_COMPANY,
};

describe("Pass 12 — shared premium shell (§2-§7/§36)", () => {
  it("every customer-facing email renders the company's own branded logo, not a hardcoded/unrelated one", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment({})],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).toContain(TEST_COMPANY.logoEmailUrl!);
  });

  it("falls back to a clean text-based company name (not a broken image) when no logo is configured", () => {
    const noLogoCompany: ResolvedCompanyBranding = { ...TEST_COMPANY, logoEmailUrl: null };
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment({})],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: noLogoCompany,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain(TEST_COMPANY.name);
  });

  it("includes a hidden preheader summary for the new-flight-option email", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment({ departureCity: "Atlanta", arrivalCity: "London" })],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).toContain("display:none");
    expect(html).toMatch(/ready to review/);
  });

  it("the professional footer shows the company name and contact info, never invented legal/registration text", () => {
    const { html } = buildBookingConfirmationEmail({ ...BASE_CONFIRMATION_P12, confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA123", eTicketNumbers: [] }] });
    expect(html).toContain(TEST_COMPANY.name);
    expect(html).toContain(TEST_COMPANY.phone!);
  });

  it("marketing campaigns render through the SAME shared card shell as transactional email (branded logo, accent bar) — not an independent copy", () => {
    const { html } = buildMarketingCampaignEmail({
      subject: "Summer Sale",
      htmlContent: "<p>Book now and save.</p>",
      unsubscribeUrl: "https://example.com/unsub?token=abc",
      company: TEST_COMPANY,
    });
    expect(html).toContain(TEST_COMPANY.logoEmailUrl!);
    expect(html).toContain(TEST_COMPANY.brandColor);
    expect(html).toContain("Unsubscribe");
  });

  it("marketing campaigns get the same mobile-safe responsive style block as every other email (§18/§33-35) — no separate, unstyled duplicate", () => {
    const { html } = buildMarketingCampaignEmail({
      subject: "Summer Sale",
      htmlContent: "<p>Book now.</p>",
      unsubscribeUrl: "https://example.com/unsub",
      company: TEST_COMPANY,
    });
    expect(html).toContain("@media only screen and (max-width: 480px)");
    expect(html).toContain("max-width:700px"); // bounded container — content can't overflow horizontally
  });

  it("every itinerary-bearing email (quote/booking/cancellation) includes the mobile-responsive stacking style", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE WAY",
      passengerCount: 1,
      segments: [makeSegment({})],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).toContain("@media only screen and (max-width: 480px)");
    expect(html).toContain("ct-seg-row");
  });

  it("marketing campaigns preserve the unsubscribe link even after the shell redesign (§42)", () => {
    const { html } = buildMarketingCampaignEmail({
      subject: "Summer Sale",
      htmlContent: "<p>Book now.</p>",
      unsubscribeUrl: "https://example.com/unsub?token=xyz",
      company: TEST_COMPANY,
    });
    expect(html).toContain("https://example.com/unsub?token=xyz");
  });
});

describe("Pass 12 — customer greeting safety (§8/§41)", () => {
  it("the new-flight-option email greets with 'Hello, First Last' when both are known", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Larry",
      customerLastName: "Mehaffey",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment({})],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).toContain("Hello, Larry Mehaffey");
    expect(html).not.toContain("undefined");
  });

  it("degrades gracefully to first-name-only when no last name is supplied — never 'Hello, undefined'", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Larry",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment({})],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).toContain("Hello, Larry");
    expect(html).not.toContain("undefined");
  });

  it("booking confirmation degrades gracefully when the customer's first name is empty — never 'Hi undefined' or 'Hi ,'", () => {
    const { html } = buildBookingConfirmationEmail({ ...BASE_CONFIRMATION_P12, customerFirstName: "", confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA123", eTicketNumbers: [] }] });
    expect(html).toContain("Hi there");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("Hi ,");
  });
});

describe("Pass 12 — subject line format (§40)", () => {
  it("uses 'Your Flight Option: {route}' for a one-way quote, never an internal Quote ID", () => {
    const { subject } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE WAY",
      passengerCount: 1,
      segments: [makeSegment({ departureAirportCode: "ATL", departureCity: "Atlanta", arrivalAirportCode: "LHR", arrivalCity: "London" })],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(subject).toBe(`Your Flight Option: Atlanta (ATL) to London (LHR) | ${TEST_COMPANY.name}`);
  });

  it("uses 'Your Flight Options: {route} and Return' for a round trip", () => {
    const { subject } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ROUND TRIP",
      passengerCount: 1,
      segments: [
        makeSegment({ id: "1", departureAirportCode: "ATL", departureCity: "Atlanta", arrivalAirportCode: "LHR", arrivalCity: "London", connectionType: null }),
      ],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(subject).toBe(`Your Flight Options: Atlanta (ATL) to London (LHR) and Return | ${TEST_COMPANY.name}`);
  });

  it("uses a distinct 'Proposed Flight Exchange' subject for an exchange quote", () => {
    const { subject } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE WAY",
      passengerCount: 1,
      segments: [makeSegment({ departureAirportCode: "ATL", departureCity: "Atlanta", arrivalAirportCode: "LHR", arrivalCity: "London" })],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
      originalItinerarySegments: [makeSegment({})],
    });
    expect(subject).toContain("Proposed Flight Exchange");
    expect(subject.toLowerCase()).not.toContain("quote-");
  });
});

// Job 2 — every customer subject ends with "| {company.name}", using the
// ACTUAL company passed in (via the shared withCompanySuffix helper), never
// a hardcoded string. This fixture's name is deliberately NOT "Compass
// Tools" or "Test Travel Co"/"Business Flights Travel" — a coincidental
// match with some other hardcoded string would hide a real bug here.
describe("customer email subjects append the actual configured company name", () => {
  const DYNAMIC_COMPANY: ResolvedCompanyBranding = { ...TEST_COMPANY, name: "Zephyr Voyages International" };

  it("booking confirmation: 'Your Booking is Confirmed | {company.name}'", () => {
    const { subject } = buildBookingConfirmationEmail({
      customerFirstName: "Jane",
      bookingReference: "BFT-TEST",
      segments: [makeSegment({})],
      pricing: PRICING,
      paymentMethods: [],
      paymentPaid: true,
      passengers: [],
      contactName: "Jane Doe",
      contactEmail: "jane@example.com",
      contactPhone: "+15551234567",
      confirmations: [],
      company: DYNAMIC_COMPANY,
    });
    expect(subject).toBe(`Your Booking is Confirmed | ${DYNAMIC_COMPANY.name}`);
  });

  it("new flight option: '{route} | {company.name}', route derived exactly as the existing subject logic already does", () => {
    const { subject } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE WAY",
      passengerCount: 1,
      segments: [makeSegment({ departureAirportCode: "ATL", departureCity: "Atlanta", arrivalAirportCode: "LHR", arrivalCity: "London" })],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: DYNAMIC_COMPANY,
    });
    expect(subject).toBe(`Your Flight Option: Atlanta (ATL) to London (LHR) | ${DYNAMIC_COMPANY.name}`);
  });

  it("proposed exchange: 'Proposed Flight Exchange: {route} | {company.name}'", () => {
    const { subject } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE WAY",
      passengerCount: 1,
      segments: [makeSegment({ departureAirportCode: "ATL", departureCity: "Atlanta", arrivalAirportCode: "LHR", arrivalCity: "London" })],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: DYNAMIC_COMPANY,
      originalItinerarySegments: [makeSegment({})],
    });
    expect(subject).toBe(`Proposed Flight Exchange: Atlanta (ATL) to London (LHR) | ${DYNAMIC_COMPANY.name}`);
  });

  it("exchange confirmation: 'Your Flight Exchange is Confirmed | {company.name}'", () => {
    const { subject } = buildBookingConfirmationEmail({
      customerFirstName: "Jane",
      bookingReference: "BFT-TEST",
      segments: [makeSegment({})],
      pricing: PRICING,
      paymentMethods: [],
      paymentPaid: true,
      passengers: [],
      contactName: "Jane Doe",
      contactEmail: "jane@example.com",
      contactPhone: "+15551234567",
      confirmations: [],
      company: DYNAMIC_COMPANY,
      exchange: { exchangeFee: 150, fareDifference: 320.5, currency: "USD" },
    });
    expect(subject).toBe(`Your Flight Exchange is Confirmed | ${DYNAMIC_COMPANY.name}`);
  });

  it("cancellation request: 'Cancellation Requested — Please Confirm {N} Flight Segment(s) | {company.name}', N computed from the actual cancelled-segment count, singular/plural correct", () => {
    const oneSegment = buildCancellationScheduledEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      segments: [makeSegment({ id: "seg-1" })],
      cancelledSegmentIds: new Set(["seg-1"]),
      viewDealUrl: "https://example.com/deal",
      company: DYNAMIC_COMPANY,
    });
    expect(oneSegment.subject).toBe(`Cancellation Requested — Please Confirm 1 Flight Segment | ${DYNAMIC_COMPANY.name}`);

    const twoSegments = buildCancellationScheduledEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      segments: [makeSegment({ id: "seg-1" }), makeSegment({ id: "seg-2" })],
      cancelledSegmentIds: new Set(["seg-1", "seg-2"]),
      viewDealUrl: "https://example.com/deal",
      company: DYNAMIC_COMPANY,
    });
    expect(twoSegments.subject).toBe(`Cancellation Requested — Please Confirm 2 Flight Segments | ${DYNAMIC_COMPANY.name}`);
  });

  it("cancellation confirmation: existing wording preserved, with '| {company.name}' appended", () => {
    const { subject } = buildCancellationConfirmedEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      segments: [makeSegment({ id: "seg-1" })],
      cancelledSegmentIds: new Set(["seg-1"]),
      company: DYNAMIC_COMPANY,
    });
    expect(subject).toBe(`Cancellation Confirmed — 1 Flight Segment | ${DYNAMIC_COMPANY.name}`);
  });

  it("never double-appends when a subject already names the company (buildCvvRecollectionEmail's existing em-dash suffix)", () => {
    const { subject } = buildCvvRecollectionEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      cardBrand: "Visa",
      last4: "4242",
      confirmUrl: "https://example.com/cvv",
      company: DYNAMIC_COMPANY,
    });
    expect(subject).toBe(`Please confirm your card's security code — ${DYNAMIC_COMPANY.name}`);
    // Exactly one occurrence of the company name — not duplicated.
    expect(subject.split(DYNAMIC_COMPANY.name).length - 1).toBe(1);
  });

  it("internal notification subjects are never touched by the customer-subject suffix", () => {
    const { subject } = buildBookingSignedNotificationEmail({
      customerFullName: "Jane Doe",
      contactEmail: "jane@example.com",
      contactPhone: "+15551234567",
      bookingReference: "BFT-TEST",
      signedName: "Jane Doe",
      signedAt: new Date("2026-01-01T00:00:00Z"),
      ipAddress: null,
      segments: [makeSegment({})],
      passengers: [],
      pricing: PRICING,
      paymentMethods: [],
      paymentPaid: true,
      bookingUrl: "https://example.com/bookings/1",
      company: DYNAMIC_COMPANY,
    });
    expect(subject).toBe("Booking Form Signed — BFT-TEST");
    expect(subject).not.toContain(DYNAMIC_COMPANY.name);
  });
});

// Job 3 — the exchange-proposal EMAIL shows ONLY the proposed itinerary, not
// the original. This is specific to buildQuoteEmail's email rendering; the
// CRM's own exchange-builder UI and the customer's View Deal quote page
// (quote/[token]/page.tsx) are untouched and continue to show both.
describe("buildQuoteEmail (exchange proposal) — email shows only the proposed itinerary", () => {
  const originalSegment = makeSegment({
    id: "original-1",
    departureAirportCode: "JFK",
    departureCity: "New York",
    arrivalAirportCode: "MIA",
    arrivalCity: "Miami",
    flightNumber: "OLD100",
  });
  const proposedSegment = makeSegment({
    id: "proposed-1",
    departureAirportCode: "ATL",
    departureCity: "Atlanta",
    arrivalAirportCode: "LHR",
    arrivalCity: "London",
    flightNumber: "NEW200",
  });

  it("contains the proposed itinerary's content but no 'Your Original Itinerary' heading or the original segment's own flight number", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE WAY",
      passengerCount: 1,
      segments: [proposedSegment],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
      originalItinerarySegments: [originalSegment],
    });
    expect(html).toContain("Proposed Exchange Itinerary");
    expect(html).toContain("NEW200");
    expect(html).toContain("Atlanta");
    expect(html).not.toContain("Your Original Itinerary");
    expect(html).not.toContain("OLD100");
    expect(html).not.toContain("New York");
  });

  it("an ordinary (non-exchange) quote email is completely unaffected — still shows its one itinerary under 'Flight Itinerary'", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE WAY",
      passengerCount: 1,
      segments: [proposedSegment],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).toContain("Flight Itinerary");
    expect(html).toContain("NEW200");
    expect(html).not.toContain("Your Original Itinerary");
    expect(html).not.toContain("Proposed Exchange Itinerary");
  });
});

describe("Pass 12 — booking confirmation: heading, passenger count, exchange summary (§9/§11/§26)", () => {
  it("shows a 'Booking Confirmed' heading badge for an ordinary booking", () => {
    const { html } = buildBookingConfirmationEmail({ ...BASE_CONFIRMATION_P12, confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA123", eTicketNumbers: [] }] });
    expect(html).toContain("Booking Confirmed");
  });

  it("shows the passenger count alongside the itinerary", () => {
    const { html } = buildBookingConfirmationEmail({ ...BASE_CONFIRMATION_P12, confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA123", eTicketNumbers: [] }] });
    expect(html).toContain("2 passengers");
  });

  it("switches to an 'Exchange Confirmed' heading and shows the Exchange Fee + Fare Difference = Total breakdown when `exchange` is set", () => {
    const { html, subject } = buildBookingConfirmationEmail({
      ...BASE_CONFIRMATION_P12,
      confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA123", eTicketNumbers: [] }],
      exchange: { exchangeFee: 150, fareDifference: 320.5, currency: "USD" },
    });
    expect(subject).toMatch(/Exchange/);
    expect(html).toContain("Exchange Confirmed");
    expect(html).toContain("Exchange Fee");
    expect(html).toContain("Fare Difference");
    expect(html).toContain("Total Exchange Amount");
    expect(html).toContain("$150.00");
    expect(html).toContain("$320.50");
    expect(html).toContain("$470.50"); // 150 + 320.50, exact same formula as the customer quote page
  });

  it("an ordinary (non-exchange) booking never shows the Exchange Summary block", () => {
    const { html } = buildBookingConfirmationEmail({ ...BASE_CONFIRMATION_P12, confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA123", eTicketNumbers: [] }] });
    expect(html).not.toContain("Exchange Summary");
  });

  // Pass 28 — real bug found and fixed: this exact block previously built
  // its Exchange Fee/Fare Difference/Total rows with a raw
  // `${symbol}${fmtMoney(n)}`, which renders a negative amount (a
  // lower-priced replacement fare — see Quote.fareDifference's own schema
  // doc comment) as "$-50.00" instead of "-$50.00". Pins the fix using
  // this file's own fmtSignedMoney(), which the "positive" test above
  // can't catch since toLocaleString's sign placement only differs from
  // the correct one when the number is actually negative.
  it("a negative Fare Difference (a lower-priced replacement fare) renders '-$' before the symbol, never '$-'", () => {
    const { html } = buildBookingConfirmationEmail({
      ...BASE_CONFIRMATION_P12,
      confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA123", eTicketNumbers: [] }],
      exchange: { exchangeFee: 150, fareDifference: -50, currency: "USD" },
    });
    expect(html).toContain("-$50.00");
    expect(html).not.toContain("$-50.00");
    // Total Exchange Amount: 150 + (-50) = 100, still positive here.
    expect(html).toContain("$100.00");
  });

  it("a Total Exchange Amount that goes negative overall also renders '-$' before the symbol", () => {
    const { html } = buildBookingConfirmationEmail({
      ...BASE_CONFIRMATION_P12,
      confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA123", eTicketNumbers: [] }],
      exchange: { exchangeFee: 20, fareDifference: -50, currency: "USD" },
    });
    expect(html).toContain("-$30.00"); // 20 + (-50) = -30
    expect(html).not.toContain("$-30.00");
  });

  it("the confirmation number lives in its own clearly-labeled visual block, distinct from the heading", () => {
    const { html } = buildBookingConfirmationEmail({ ...BASE_CONFIRMATION_P12, confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA-998877", eTicketNumbers: ["TICKET-1"] }] });
    expect(html).toContain("Airline Confirmation");
    expect(html).toContain("AA-998877");
  });
});

describe("Pass 12 — cancellation headings distinguish requested vs completed (§12/§43)", () => {
  const CANCEL_BASE = {
    customerFirstName: "Jane",
    agentFullName: "Agent Smith",
    segments: [makeSegment({ id: "seg-cancel" })],
    cancelledSegmentIds: new Set(["seg-cancel"]),
    company: TEST_COMPANY,
  };

  it("the scheduled/requested email says 'Going to Be Cancelled', never 'Completed'", () => {
    const { html } = buildCancellationScheduledEmail({ ...CANCEL_BASE, viewDealUrl: "https://example.com/deal" });
    expect(html).toMatch(/Going to Be Cancelled|Cancellation Notice/);
    expect(html).not.toContain("Cancellation Completed");
    expect(html).toContain("not been cancelled yet");
  });

  it("the confirmed email says 'Cancellation Completed', not merely 'Requested'", () => {
    const { html } = buildCancellationConfirmedEmail(CANCEL_BASE);
    expect(html).toContain("Cancellation Completed");
  });

  it("the cancellation warning is never communicated by color alone — real text accompanies it", () => {
    const { html } = buildCancellationScheduledEmail({ ...CANCEL_BASE, viewDealUrl: "https://example.com/deal" });
    expect(html).toMatch(/scheduled for cancellation/i);
  });
});

describe("Pass 12 — multi-city journey groups are calculated and shown SEPARATELY (§22/§23)", () => {
  it("two separate Multi City journeys (ATL->LHR, then a later LHR->CPH->ATL) each get their OWN total journey time, never combined into one", () => {
    const segments: EmailSegment[] = [
      // Journey group 1: a single nonstop flight, ATL -> LHR.
      makeSegment({
        id: "g1-1",
        connectionType: null,
        departureAirportCode: "ATL",
        departureCity: "Atlanta",
        arrivalAirportCode: "LHR",
        arrivalCity: "London",
        departureAt: toAirportDateTime("2026-10-13", "19:00"),
        departureTimezone: "America/New_York",
        arrivalAt: toAirportDateTime("2026-10-14", "07:00"),
        arrivalTimezone: "Europe/London",
        durationMinutes: 8 * 60,
      }),
      // Journey group 2 — explicitly MULTI_CITY, so this starts a brand
      // new journey rather than being treated as a connection off group 1
      // (must NOT infer a connection purely from airport equality/timing —
      // the itinerary's own connectionType marker is authoritative).
      makeSegment({
        id: "g2-1",
        connectionType: "MULTI_CITY",
        departureAirportCode: "LHR",
        departureCity: "London",
        arrivalAirportCode: "CPH",
        arrivalCity: "Copenhagen",
        departureAt: toAirportDateTime("2026-10-20", "09:00"),
        departureTimezone: "Europe/London",
        arrivalAt: toAirportDateTime("2026-10-20", "11:50"),
        arrivalTimezone: "Europe/Copenhagen",
        durationMinutes: 110,
      }),
      makeSegment({
        id: "g2-2",
        connectionType: "LAYOVER", // a real connection WITHIN journey group 2
        departureAirportCode: "CPH",
        departureCity: "Copenhagen",
        arrivalAirportCode: "ATL",
        arrivalCity: "Atlanta",
        departureAt: toAirportDateTime("2026-10-20", "14:55"),
        departureTimezone: "Europe/Copenhagen",
        arrivalAt: toAirportDateTime("2026-10-20", "18:50"),
        arrivalTimezone: "America/New_York",
        durationMinutes: 9 * 60 + 55,
      }),
    ];

    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "MULTI_CITY",
      passengerCount: 1,
      segments,
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });

    // Group 1's own total (a nonstop flight — total = its one flight duration = 12h, real elapsed ATL->LHR).
    // Group 2's own total (14h50 — the exact Pass 11/12 worked example).
    expect(html).toContain("Flight 1"); // multi-leg grouping label present
    expect(html).toContain("Flight 2");
    expect(html).toContain("14h 50m"); // group 2's independently-calculated total
    // The two groups' totals must never be summed into one combined
    // number — 12h (group 1) + 14h50 (group 2) = 26h50, which must NOT
    // appear anywhere as a "total journey time" figure.
    expect(html).not.toMatch(/26h\s*50m\s*<\/strong>\s*total journey time/);
  });
});

describe("Pass 12 — HTML regression: no broken/placeholder output anywhere (§45)", () => {
  it("a quote email never contains 'undefined', '[object Object]', or an internal Quote ID pattern", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      customerLastName: "Doe",
      agentFullName: "Agent Smith",
      tripType: "ONE WAY",
      passengerCount: 2,
      segments: [makeSegment({}), makeSegment({ id: "seg-2", connectionType: "LAYOVER" })],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object Object]");
    expect(html).not.toMatch(/quote-[a-z0-9]{20,}/i); // cuid-shaped internal id
  });

  it("a booking confirmation with zero payment methods never renders 'undefined' for the payment line", () => {
    const { html } = buildBookingConfirmationEmail({ ...BASE_CONFIRMATION_P12, confirmations: [{ id: "1", airlineName: null, confirmationNumber: "AA123", eTicketNumbers: [] }] });
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object Object]");
  });

  it("a multi-connection itinerary (3 segments, 2 connections) renders cleanly with no broken output", () => {
    const segments = [
      makeSegment({ id: "s1", connectionType: null }),
      makeSegment({ id: "s2", connectionType: "LAYOVER" }),
      makeSegment({ id: "s3", connectionType: "LAYOVER" }),
    ];
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE WAY",
      passengerCount: 1,
      segments,
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: TEST_COMPANY,
    });
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });
});

// Pass 24 — company.name/agentFullName were interpolated into several
// email HTML outputs (both an `alt="..."` attribute and plain text nodes)
// without escapeHtml(), unlike most other dynamic strings in this module.
// Both are admin/staff-configured, not directly customer-submitted, but
// the fix is the same either way: escape everything the same way, no
// special-cased "trusted" field. These prove a value containing HTML
// metacharacters never reaches the rendered output unescaped, across the
// several builders touched by the fix.
describe("Pass 24 — company.name/agentFullName HTML-escaping fix", () => {
  const XSS_COMPANY: ResolvedCompanyBranding = { ...TEST_COMPANY, name: `<img src=x onerror=alert(1)> & "Co"` };
  const XSS_AGENT_NAME = `<script>alert(1)</script> Kent`;

  it("buildQuoteEmail (exchange path) escapes both agentFullName and company.name in the intro paragraph", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: XSS_AGENT_NAME,
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment({})],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: XSS_COMPANY,
      originalItinerarySegments: [makeSegment({})],
    });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("buildQuoteEmail's logo alt attribute escapes company.name", () => {
    const { html } = buildQuoteEmail({
      customerFirstName: "Jane",
      agentFullName: "Agent Smith",
      tripType: "ONE_WAY",
      passengerCount: 1,
      segments: [makeSegment({})],
      pricing: PRICING,
      viewDealUrl: "https://example.com/deal",
      company: XSS_COMPANY,
    });
    expect(html).not.toContain('alt="<img');
    expect(html).toContain("&lt;img");
  });

  it("buildCancellationScheduledEmail escapes company.name and agentFullName", () => {
    const seg = makeSegment({ id: "cancel-me" });
    const { html } = buildCancellationScheduledEmail({
      customerFirstName: "Jane",
      agentFullName: XSS_AGENT_NAME,
      segments: [seg],
      cancelledSegmentIds: new Set(["cancel-me"]),
      cancellationFee: 50,
      currency: "USD",
      viewDealUrl: "https://example.com/quote/abc",
      company: XSS_COMPANY,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("buildCancellationConfirmedEmail escapes company.name and agentFullName", () => {
    const seg = makeSegment({ id: "cancel-me" });
    const { html } = buildCancellationConfirmedEmail({
      customerFirstName: "Jane",
      agentFullName: XSS_AGENT_NAME,
      segments: [seg],
      cancelledSegmentIds: new Set(["cancel-me"]),
      company: XSS_COMPANY,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
  });

  it("buildBookingConfirmationEmail's pending-state intro text escapes company.name", () => {
    const { html } = buildBookingConfirmationEmail({
      customerFirstName: "Jane",
      bookingReference: "BK-1",
      segments: [makeSegment({})],
      pricing: PRICING,
      paymentMethods: [],
      paymentPaid: true,
      passengers: [{ firstName: "Jane", middleName: null, lastName: "Doe", dateOfBirth: null, type: "ADULT" }],
      contactName: "Jane Doe",
      contactEmail: "jane@example.com",
      contactPhone: "555-1212",
      confirmations: [],
      company: XSS_COMPANY,
    });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });
});
