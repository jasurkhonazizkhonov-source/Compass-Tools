import { describe, it, expect } from "vitest";
import { getPassengerCount } from "../passengers";

// Pass 12 §26/§27 — the ONE passenger-count source of truth reused by the
// Quotes list and Bookings list columns.

describe("getPassengerCount", () => {
  it("sums adults + children + infants", () => {
    expect(getPassengerCount({ adults: 2, children: 1, infants: 0 })).toBe(3);
  });

  it("a solo adult traveler counts as 1, not 0", () => {
    expect(getPassengerCount({ adults: 1, children: 0, infants: 0 })).toBe(1);
  });

  it("handles legacy/incomplete rows gracefully — null/undefined fields count as 0, never NaN/undefined in the UI", () => {
    expect(getPassengerCount({ adults: 2, children: null, infants: undefined })).toBe(2);
    expect(getPassengerCount({ adults: null, children: null, infants: null })).toBe(0);
    expect(getPassengerCount({ adults: undefined, children: undefined, infants: undefined })).toBe(0);
  });

  it("never returns NaN even with every field missing", () => {
    const result = getPassengerCount({ adults: undefined, children: undefined, infants: undefined });
    expect(Number.isNaN(result)).toBe(false);
  });
});
