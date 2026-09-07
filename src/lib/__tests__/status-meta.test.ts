import { describe, it, expect } from "vitest";
import { leadSourceLabel, LEAD_STATUS_META, QUOTE_STATUS_META } from "../status-meta";

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
