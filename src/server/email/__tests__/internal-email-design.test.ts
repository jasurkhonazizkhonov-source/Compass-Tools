import { describe, it, expect } from "vitest";
import {
  buildBookingProfitNotificationEmail,
  buildContactReassignmentEmail,
  buildLeadReassignmentEmail,
  buildNewFlightRequestEmail,
  type ContactReassignmentEmailParams,
  type LeadReassignmentEmailParams,
  type NewFlightRequestEmailParams,
} from "../templates";
import type { ResolvedCompanyBranding } from "@/lib/company-config";

// One design system for every internal notification: New Flight Request,
// Lead/Contact Reassigned (both directions) and New Sale all render through
// the same shell (Internal CRM Notification header, company logo, responsive
// stylesheet, restrained footer). These tests pin that, plus the safety of
// the two reassignment templates against hostile and very long content.

const COMPANY: ResolvedCompanyBranding = {
  id: "co-1",
  name: "Test Travel Co",
  website: "https://test.example.com",
  phone: "+1 555 000 0000",
  brandColor: "#1c3a5e",
  logoEmailUrl: "https://test.example.com/logo-email.png",
  logoWebUrl: "https://test.example.com/logo-web.png",
  logoIconUrl: "https://test.example.com/logo-icon.png",
  signatureTemplate: "",
};
const LAX = { iata: "LAX", name: "Los Angeles International Airport", city: "Los Angeles", country: "United States" };
const CDG = { iata: "CDG", name: "Charles de Gaulle Airport", city: "Paris", country: "France" };

const LEAD_DETAIL = {
  company: COMPANY,
  customerFullName: "Jordan Q. Rivera",
  customerEmail: "jordan@example.com",
  customerPhone: "+14155550123",
  customerPhoneDisplay: "+1 415 555 0123",
  customerCountry: "United States",
  tripType: "ROUND_TRIP" as const,
  cabinClass: "BUSINESS" as const,
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
  notes: "Prefer a morning departure.",
};

const NEW_REQUEST: NewFlightRequestEmailParams = { ...LEAD_DETAIL, submittedAt: new Date("2026-10-01T15:04:00Z"), acceptedAt: new Date("2026-10-01T15:05:00Z"), acceptedByName: "Andrew Kent" };

const LEAD_REASSIGN = (direction: "AWAY" | "TO_YOU", over: Partial<LeadReassignmentEmailParams> = {}): LeadReassignmentEmailParams => ({
  ...LEAD_DETAIL,
  direction,
  recipientFullName: direction === "AWAY" ? "Nigora Dadabaeva" : "Andrew Kent",
  status: "QUOTED",
  source: "WEBSITE",
  newOwnerName: "Andrew Kent",
  previousOwnerName: "Nigora Dadabaeva",
  reassignedByName: "Sarah Admin",
  reassignedAt: new Date("2026-10-02T12:51:00Z"),
  reason: null,
  leadUrl: direction === "TO_YOU" ? "https://crm.example.com/leads/lead-1" : null,
  ...over,
});

const CONTACT_REASSIGN = (direction: "AWAY" | "TO_YOU", over: Partial<ContactReassignmentEmailParams> = {}): ContactReassignmentEmailParams => ({
  company: COMPANY,
  direction,
  recipientFullName: direction === "AWAY" ? "Nigora Dadabaeva" : "Andrew Kent",
  contactFullName: "Jordan Q. Rivera",
  contactEmail: "jordan@example.com",
  contactPhone: "+14155550123",
  contactPhoneDisplay: "+1 415 555 0123",
  contactCountry: "United States",
  leadCount: 2,
  newOwnerName: "Andrew Kent",
  previousOwnerName: "Nigora Dadabaeva",
  reassignedByName: "Sarah Admin",
  reassignedAt: new Date("2026-10-02T12:51:00Z"),
  reason: null,
  contactUrl: direction === "TO_YOU" ? "https://crm.example.com/contacts/contact-1" : null,
  ...over,
});

const NEW_SALE = () =>
  buildBookingProfitNotificationEmail({
    agentFullName: "Andrew Kent",
    agentRole: "Travel Agent",
    agentLocation: "Los Angeles",
    hireAgeCompact: "1Y2M3D",
    profit: 550,
    destination: "Paris, France",
    currency: "USD",
    bookingReference: "BFT-1",
    passengerCount: 2,
    ticketBookingCost: 1450,
    sellingCost: 2000,
    segments: [],
    company: COMPANY,
  });

const ALL: Array<[string, () => { subject: string; html: string }]> = [
  ["New Flight Request", () => buildNewFlightRequestEmail(NEW_REQUEST)],
  ["Lead Reassigned (previous owner)", () => buildLeadReassignmentEmail(LEAD_REASSIGN("AWAY"))],
  ["Lead Reassigned to You (new owner)", () => buildLeadReassignmentEmail(LEAD_REASSIGN("TO_YOU"))],
  ["Contact Reassigned (previous owner)", () => buildContactReassignmentEmail(CONTACT_REASSIGN("AWAY"))],
  ["Contact Reassigned to You (new owner)", () => buildContactReassignmentEmail(CONTACT_REASSIGN("TO_YOU"))],
  ["New Sale", NEW_SALE],
];

describe("internal notification emails — one shared design system", () => {
  for (const [name, build] of ALL) {
    it(`${name}: Internal CRM Notification header, company logo, viewport meta + responsive stylesheet, no fabricated trust claims`, () => {
      const { html } = build();
      expect(html).toContain("Internal CRM Notification");
      expect(html).toContain(COMPANY.logoEmailUrl!);
      expect(html).toContain(`alt="${COMPANY.name}"`);
      expect(html).toContain('<meta name="viewport"');
      expect(html).toContain("@media");
      expect(html).not.toMatch(/certified|guarantee|secure(d)? by|PCI|SOC ?2|ISO ?27001|100% safe|verified by/i);
      expect(html).not.toMatch(/Business Flights/i);
    });

    it(`${name}: falls back to the company name when no logo is configured (no broken image)`, () => {
      const b = build();
      expect(b.html).toContain("<img");
      // re-render with no logo by swapping the shared fixture's logo
      const saved = COMPANY.logoEmailUrl;
      (COMPANY as { logoEmailUrl: string | null }).logoEmailUrl = null;
      try {
        const { html } = build();
        expect(html).not.toContain("<img");
        expect(html).toContain(COMPANY.name);
      } finally {
        (COMPANY as { logoEmailUrl: string | null }).logoEmailUrl = saved;
      }
    });
  }

  it("the reassignment subjects carry no internal ids and are clearly distinct from New Flight Request", () => {
    const subjects = ALL.map(([, b]) => b().subject);
    for (const s of subjects) expect(s).not.toMatch(/\bc[a-z0-9]{24}\b/);
    expect(subjects.filter((s) => /^New Flight Request/.test(s))).toHaveLength(1);
    expect(subjects.filter((s) => /Reassigned/.test(s))).toHaveLength(4);
  });
});

describe("reassignment templates — safety and layout", () => {
  it("escapes hostile text in every user-controlled field (name, reason, notes, owner and actor names, airline)", () => {
    const hostile = `<script>alert(1)</script>`;
    const lead = buildLeadReassignmentEmail(
      LEAD_REASSIGN("TO_YOU", { customerFullName: hostile, reason: hostile, notes: hostile, newOwnerName: hostile, previousOwnerName: hostile, reassignedByName: hostile, preferredAirline: hostile, recipientFullName: hostile })
    );
    const contact = buildContactReassignmentEmail(CONTACT_REASSIGN("TO_YOU", { contactFullName: hostile, reason: hostile, newOwnerName: hostile, previousOwnerName: hostile, reassignedByName: hostile, recipientFullName: hostile }));
    for (const html of [lead.html, contact.html]) {
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
    }
  });

  it("stays layout-safe for very long names and emails, and stacks key/value rows on narrow screens", () => {
    const long = "A".repeat(180);
    const { html } = buildLeadReassignmentEmail(LEAD_REASSIGN("TO_YOU", { customerFullName: long, customerEmail: `${"b".repeat(90)}@${"c".repeat(60)}.example.com`, departureAirport: { ...LAX, name: "N".repeat(150) } }));
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("table-layout:fixed");
    expect(html).toContain(".ct-kv-label");
  });

  it("never exposes database ids, tokens or payment data", () => {
    for (const [, build] of ALL.slice(1, 5)) {
      const { html, subject } = build();
      const all = `${subject}\n${html}`;
      expect(all).not.toMatch(/\b(?:\d[ -]?){13,19}\b/);
      expect(all).not.toMatch(/cvv|cvc|password|token|secret|encrypted/i);
    }
  });

  it("a reason is shown only when one was given", () => {
    expect(buildLeadReassignmentEmail(LEAD_REASSIGN("AWAY")).html).not.toContain(">Reason<");
    expect(buildLeadReassignmentEmail(LEAD_REASSIGN("AWAY", { reason: "On leave" })).html).toContain("On leave");
  });

  it("the previous-owner variant never contains a 'View Lead' button and the new-owner variant a single 'Open Lead' button", () => {
    const away = buildLeadReassignmentEmail(LEAD_REASSIGN("AWAY", { leadUrl: "https://crm.example.com/leads/lead-1" })).html;
    expect(away).not.toContain("View Lead");
    expect(away).toContain(">Lead Link<");
    const toYou = buildLeadReassignmentEmail(LEAD_REASSIGN("TO_YOU")).html;
    expect(toYou.match(/>Open Lead</g)).toHaveLength(1);
  });
});
