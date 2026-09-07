import { describe, it, expect } from "vitest";
import { getBookingType } from "../booking-type";

// Pass 13 §7 — the Bookings-list "Type" column derivation. Purely computed
// from Quote.status/Quote.originalQuoteId (already-authoritative structured
// data), never a stored field, so it stays consistent through every
// downstream transition (ticketing, cancellation lifecycle, etc.) with
// zero schema change.

describe("getBookingType", () => {
  it("an ordinary charged quote is a New Ticket", () => {
    expect(getBookingType({ status: "CHARGED", originalQuoteId: null })).toBe("NEW_TICKET");
  });

  it("a quote created from an exchange (originalQuoteId set) is an Exchange", () => {
    expect(getBookingType({ status: "CHARGED", originalQuoteId: "quote-original" })).toBe("EXCHANGE");
  });

  it.each([
    "PENDING_CANCELLATION_APPROVAL",
    "CANCELLATION_APPROVED",
    "CANCELLATION_FORM_SENT",
    "CANCELLATION_SUBMITTED",
    "CANCELLATION_CONFIRMED",
  ])("any cancellation-lifecycle status (%s) is a Cancellation", (status) => {
    expect(getBookingType({ status, originalQuoteId: null })).toBe("CANCELLATION");
  });

  it("a cancellation against an exchange-originated quote is still classified as Cancellation, not Exchange — the more specific/recent event wins", () => {
    expect(getBookingType({ status: "CANCELLATION_CONFIRMED", originalQuoteId: "quote-original" })).toBe("CANCELLATION");
  });

  it("remains New Ticket through the ordinary post-sale lifecycle (SIGNED/BOOKED/CHARGED are not cancellation statuses)", () => {
    expect(getBookingType({ status: "SIGNED", originalQuoteId: null })).toBe("NEW_TICKET");
    expect(getBookingType({ status: "BOOKED", originalQuoteId: null })).toBe("NEW_TICKET");
  });
});
