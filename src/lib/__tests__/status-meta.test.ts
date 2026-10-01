import { describe, it, expect } from "vitest";
import { leadSourceLabel, LEAD_STATUS_META, QUOTE_STATUS_META, inquirySubjectLabel, INQUIRY_SUBJECT_LABELS, CRM_INQUIRY_SUBJECT_LABELS } from "../status-meta";

// Compass Tools CRM Inquiries and Business Flights Get In Touch share one
// InquirySubject enum (see src/lib/inquiry-source.ts) but must read as two
// different products' topics — never the same label implying the wrong
// business. inquirySubjectLabel is the one place that distinction is made.
describe("inquirySubjectLabel", () => {
  it("shows Compass Tools CRM topics for a CRM_WEBSITE inquiry", () => {
    expect(inquirySubjectLabel("CRM_WEBSITE", "GENERAL_INQUIRY")).toBe("General Compass Tools Inquiry");
    expect(inquirySubjectLabel("CRM_WEBSITE", "FLIGHT_REQUEST_HELP")).toBe("CRM Demo Request");
  });

  it("shows Business Flights' own travel topics for a BUSINESS_FLIGHTS_WEBSITE inquiry, unchanged", () => {
    expect(inquirySubjectLabel("BUSINESS_FLIGHTS_WEBSITE", "GENERAL_INQUIRY")).toBe("General Inquiry");
    expect(inquirySubjectLabel("BUSINESS_FLIGHTS_WEBSITE", "FLIGHT_REQUEST_HELP")).toBe("Flight Request Help");
  });

  it("never shows a travel-flavored label for a CRM inquiry, and vice versa", () => {
    for (const subject of Object.keys(CRM_INQUIRY_SUBJECT_LABELS) as (keyof typeof CRM_INQUIRY_SUBJECT_LABELS)[]) {
      if (subject === "OTHER") continue; // the one label the two systems intentionally share
      expect(CRM_INQUIRY_SUBJECT_LABELS[subject]).not.toBe(INQUIRY_SUBJECT_LABELS[subject]);
    }
  });
});

describe("leadSourceLabel", () => {
  it("labels PHONE as Incoming Call", () => {
    expect(leadSourceLabel("PHONE")).toBe("Incoming Call");
  });
  it("labels OTHER as New Request", () => {
    expect(leadSourceLabel("OTHER")).toBe("New Request");
  });
  it("keeps Referral as-is (no override needed)", () => {
    expect(leadSourceLabel("REFERRAL")).toBe("Referral");
  });
  it("falls back to Title Case for every other existing source value", () => {
    expect(leadSourceLabel("WEBSITE")).toBe("Website");
    expect(leadSourceLabel("EMAIL")).toBe("Email");
    expect(leadSourceLabel("WHATSAPP")).toBe("Whatsapp");
    expect(leadSourceLabel("FACEBOOK")).toBe("Facebook");
    expect(leadSourceLabel("INSTAGRAM")).toBe("Instagram");
  });
});

describe("LEAD_STATUS_META.ACCEPTED", () => {
  it("uses the success (green) tone", () => {
    expect(LEAD_STATUS_META.ACCEPTED.tone).toBe("success");
  });
  it("has the label Accepted", () => {
    expect(LEAD_STATUS_META.ACCEPTED.label).toBe("Accepted");
  });
});

// Pass 26 — CANCELED (a whole quote simply discarded — see cancelQuote in
// server/actions/quotes.ts, which isQuoteCancelable already prevents from
// ever applying once a quote is BOOKED/CHARGED/mid-exchange/mid-
// cancellation) and CANCELLATION_CONFIRMED (the TRUE terminal state of the
// formal per-segment ticket-cancellation workflow — see this status's own
// doc comment in schema.prisma) are semantically different outcomes that
// must never be visually or textually interchangeable. Previously
// "Canceled"/"Cancelled" — a one-letter spelling variant, same destructive
// tone — were functionally indistinguishable at a glance.
describe("QUOTE_STATUS_META — Canceled vs Cancellation Done are visually distinct (Pass 26)", () => {
  it("CANCELED and CANCELLATION_CONFIRMED have different labels", () => {
    expect(QUOTE_STATUS_META.CANCELED.label).not.toBe(QUOTE_STATUS_META.CANCELLATION_CONFIRMED.label);
  });

  it("CANCELED and CANCELLATION_CONFIRMED have different tones", () => {
    expect(QUOTE_STATUS_META.CANCELED.tone).not.toBe(QUOTE_STATUS_META.CANCELLATION_CONFIRMED.tone);
  });

  it("CANCELED reads as a plain cancellation, destructive tone", () => {
    expect(QUOTE_STATUS_META.CANCELED).toEqual({ label: "Canceled", tone: "destructive" });
  });

  it("CANCELLATION_CONFIRMED reads as a completed process, success tone — never implying a mere discard", () => {
    expect(QUOTE_STATUS_META.CANCELLATION_CONFIRMED.tone).toBe("success");
    expect(QUOTE_STATUS_META.CANCELLATION_CONFIRMED.label.toLowerCase()).not.toBe("canceled");
    expect(QUOTE_STATUS_META.CANCELLATION_CONFIRMED.label.toLowerCase()).not.toBe("cancelled");
  });
});
