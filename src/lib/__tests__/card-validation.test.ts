import { describe, it, expect } from "vitest";
import { isValidExpiry, isPaymentAllocationValid } from "../card-validation";

describe("isValidExpiry", () => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;

  it("accepts the current month and future dates", () => {
    expect(isValidExpiry(m, y)).toBe(true);
    expect(isValidExpiry(12, y + 3)).toBe(true);
  });
  it("rejects a past month and a past year", () => {
    if (m > 1) expect(isValidExpiry(m - 1, y)).toBe(false);
    expect(isValidExpiry(12, y - 1)).toBe(false);
  });
  it("rejects an invalid month", () => {
    expect(isValidExpiry(0, y + 1)).toBe(false);
    expect(isValidExpiry(13, y + 1)).toBe(false);
    expect(isValidExpiry(1.5, y + 1)).toBe(false);
  });
  it("rejects a year far beyond any realistic card validity", () => {
    expect(isValidExpiry(1, y + 50)).toBe(false);
  });
});

describe("isPaymentAllocationValid", () => {
  it("accepts a single card that exactly covers the total", () => {
    expect(isPaymentAllocationValid([647], 647)).toBe(true);
  });
  it("accepts a split that sums to the total, tolerating float slack", () => {
    expect(isPaymentAllocationValid([100.1, 200.2], 300.3)).toBe(true);
  });
  it("rejects under- and over-allocation", () => {
    expect(isPaymentAllocationValid([600], 647)).toBe(false);
    expect(isPaymentAllocationValid([700], 647)).toBe(false);
  });
});
