import { describe, it, expect } from "vitest";
import { getCancellationPolicySections, getTermsAndConditionsSections } from "../legal-content";

// Pass 21 — Cancellation Policy / Terms & Conditions accordion content.
// The template this was adapted from referenced a fictional company
// ("TopBusinessClass", "FirstClass Choice Inc.") — these tests guard
// against that ever leaking back in, and confirm the real, configured
// company identity is what actually appears.

const COMPANY = { name: "Compass Tools Travel", phone: "+1 (555) 010-2000", website: "https://compasstools.example" };

function flatten(sections: ReturnType<typeof getCancellationPolicySections>): string {
  return JSON.stringify(sections);
}

describe("legal-content", () => {
  it("never contains the fictional template company names", () => {
    const text = flatten(getCancellationPolicySections(COMPANY)) + flatten(getTermsAndConditionsSections(COMPANY));
    expect(text).not.toMatch(/TopBusinessClass/i);
    expect(text).not.toMatch(/FirstClass Choice/i);
  });

  it("interpolates the real, configured company name into both sections", () => {
    const cancellation = flatten(getCancellationPolicySections(COMPANY));
    const terms = flatten(getTermsAndConditionsSections(COMPANY));
    expect(cancellation).toContain("Compass Tools Travel");
    expect(terms).toContain("Compass Tools Travel");
  });

  it("uses the configured phone/website as the contact channel, never an invented email address", () => {
    const text = flatten(getCancellationPolicySections(COMPANY));
    expect(text).toContain(COMPANY.phone);
    expect(text).not.toMatch(/@\w+\.\w+/); // no email-shaped string anywhere
  });

  it("falls back gracefully when phone/website are unconfigured (no dedicated support-email field exists in the schema)", () => {
    const sections = getCancellationPolicySections({ name: "Solo Co", phone: null, website: null });
    const text = JSON.stringify(sections);
    expect(text).toContain("your travel agent");
    expect(text).not.toMatch(/null/);
  });

  it("Terms & Conditions references the Cancellation Policy for cancellation/refund terms rather than duplicating or contradicting them", () => {
    const terms = getTermsAndConditionsSections(COMPANY);
    const cancellationsSection = terms.find((s) => s.heading === "Cancellations & Refunds");
    expect(cancellationsSection).toBeDefined();
    expect(JSON.stringify(cancellationsSection)).toMatch(/Cancellation Policy/);
  });

  it("Cancellation Policy has the three required top-level sections from the spec", () => {
    const sections = getCancellationPolicySections(COMPANY);
    const headings = sections.map((s) => s.heading);
    expect(headings).toEqual([
      "Standard Ticket Cancellation and Refunds",
      "Airline Rules, Itinerary Changes, and Price Changes",
      "Additional Terms",
    ]);
    const additionalTerms = sections.find((s) => s.heading === "Additional Terms");
    expect(additionalTerms?.subsections?.map((s) => s.heading)).toEqual([
      "Frequent Traveler Points",
      "Frequent Flyer Accounts",
      "Passport, Visa, and Travel Documents",
    ]);
  });

  it("Terms & Conditions has all 15 required sections from the spec, in order", () => {
    const sections = getTermsAndConditionsSections(COMPANY);
    expect(sections.map((s) => s.heading)).toEqual([
      "Review Your Confirmation",
      "Responsibility",
      "Foreign Entry Requirements",
      "Credit Card Payments",
      "Credit Card Fees & Foreign Transactions",
      "Chargebacks",
      "Airline Schedule Changes & Delays",
      "Baggage Allowance",
      "Frequent Traveler Benefits",
      "Frequent Flyer Account Assistance",
      "Cancellations & Refunds",
      "No Name Changes",
      "Fraudulent or Improper Booking Practices",
      "Taxes & Fees",
      "Indemnification",
    ]);
  });
});
