import { describe, it, expect } from "vitest";
import {
  digitsOnly,
  detectCardBrand,
  formatCardNumber,
  luhnCheck,
  isValidCardNumber,
  isValidExpiry,
  isValidCvvFormat,
  lastFour,
  isPaymentAllocationValid,
} from "../card-validation";

describe("digitsOnly", () => {
  it("strips everything but digits", () => {
    expect(digitsOnly("4111 1111-1111.1111")).toBe("4111111111111111");
  });
});

describe("detectCardBrand", () => {
  it("detects Visa (leading 4)", () => {
    expect(detectCardBrand("4111111111111111")).toBe("Visa");
  });
  it("detects Mastercard (51-55 and 2221-2720 ranges)", () => {
    expect(detectCardBrand("5555555555554444")).toBe("Mastercard");
    expect(detectCardBrand("2223000048400011")).toBe("Mastercard");
  });
  it("detects American Express (34/37)", () => {
    expect(detectCardBrand("378282246310005")).toBe("American Express");
  });
  it("detects Discover (6011/65)", () => {
    expect(detectCardBrand("6011111111111117")).toBe("Discover");
  });
  it("falls back to Unknown for an unrecognized prefix", () => {
    expect(detectCardBrand("1234567890123456")).toBe("Unknown");
  });
});

describe("formatCardNumber", () => {
  it("groups a standard card as 4-4-4-4", () => {
    expect(formatCardNumber("4111111111111111")).toBe("4111 1111 1111 1111");
  });
  it("groups an Amex card as 4-6-5", () => {
    expect(formatCardNumber("378282246310005")).toBe("3782 822463 10005");
  });
  it("caps input at 19 digits", () => {
    expect(digitsOnly(formatCardNumber("41111111111111111111111"))).toHaveLength(19);
  });
});

describe("luhnCheck / isValidCardNumber", () => {
  it("accepts a valid test Visa number", () => {
    expect(luhnCheck("4111111111111111")).toBe(true);
    expect(isValidCardNumber("4111 1111 1111 1111")).toBe(true);
  });
  it("rejects a number that fails the checksum", () => {
    expect(luhnCheck("4111111111111112")).toBe(false);
  });
  it("rejects a number that's too short or too long", () => {
    expect(luhnCheck("41111111111")).toBe(false); // 11 digits
    expect(luhnCheck("41111111111111111111")).toBe(false); // 20 digits
  });
});

describe("isValidExpiry", () => {
  it("rejects an out-of-range month", () => {
    expect(isValidExpiry(0, 2030)).toBe(false);
    expect(isValidExpiry(13, 2030)).toBe(false);
  });
  it("rejects a year already in the past", () => {
    expect(isValidExpiry(1, 2000)).toBe(false);
  });
  it("rejects the current year but an already-passed month", () => {
    const now = new Date();
    const pastMonth = now.getUTCMonth() + 1 === 1 ? 12 : now.getUTCMonth();
    const year = now.getUTCMonth() + 1 === 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
    // Only meaningful when pastMonth is genuinely before "now" in the same year.
    if (year === now.getUTCFullYear()) {
      expect(isValidExpiry(pastMonth, year)).toBe(false);
    }
  });
  it("accepts a reasonable future expiry", () => {
    const now = new Date();
    expect(isValidExpiry(now.getUTCMonth() + 1, now.getUTCFullYear() + 2)).toBe(true);
  });
  it("rejects a year far beyond any realistic card validity", () => {
    const now = new Date();
    expect(isValidExpiry(1, now.getUTCFullYear() + 50)).toBe(false);
  });
});

describe("isValidCvvFormat", () => {
  it("requires 3 digits for non-Amex brands", () => {
    expect(isValidCvvFormat("123", "Visa")).toBe(true);
    expect(isValidCvvFormat("12", "Visa")).toBe(false);
    expect(isValidCvvFormat("1234", "Visa")).toBe(false);
  });
  it("requires 4 digits for American Express", () => {
    expect(isValidCvvFormat("1234", "American Express")).toBe(true);
    expect(isValidCvvFormat("123", "American Express")).toBe(false);
  });
});

describe("lastFour", () => {
  it("returns only the last four digits, ignoring formatting", () => {
    expect(lastFour("4111 1111 1111 1111")).toBe("1111");
  });
});

describe("isPaymentAllocationValid", () => {
  it("accepts a single card that exactly covers the total", () => {
    expect(isPaymentAllocationValid([647], 647)).toBe(true);
  });

  it("accepts multiple cards that together exactly cover the total", () => {
    expect(isPaymentAllocationValid([1200, 800], 2000)).toBe(true);
  });

  it("rejects underallocation", () => {
    expect(isPaymentAllocationValid([1200, 500], 2000)).toBe(false);
  });

  it("rejects overallocation", () => {
    expect(isPaymentAllocationValid([1200, 1000], 2000)).toBe(false);
  });

  it("tolerates a cent of floating-point rounding slack", () => {
    expect(isPaymentAllocationValid([666.665, 666.665, 666.67], 2000)).toBe(true);
  });

  it("rejects an empty payment method list against any positive total", () => {
    expect(isPaymentAllocationValid([], 100)).toBe(false);
  });

  it("treats a zero total with no cards as valid (degenerate case)", () => {
    expect(isPaymentAllocationValid([], 0)).toBe(true);
  });
});
