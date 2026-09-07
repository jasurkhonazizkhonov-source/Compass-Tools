import { describe, it, expect } from "vitest";
import { maxReasonableChargeAmount, isChargeAmountAllowed } from "../payment-limits";

describe("isChargeAmountAllowed", () => {
  it("allows a reasonable charge against the booking total", () => {
    expect(isChargeAmountAllowed(250, 1125)).toBe(true);
  });

  it("allows a charge equal to the exact cap", () => {
    const total = 1000;
    expect(isChargeAmountAllowed(maxReasonableChargeAmount(total), total)).toBe(true);
  });

  it("rejects a charge that exceeds the cap", () => {
    const total = 1000;
    expect(isChargeAmountAllowed(maxReasonableChargeAmount(total) + 0.01, total)).toBe(false);
  });

  it("rejects zero and negative amounts", () => {
    expect(isChargeAmountAllowed(0, 1000)).toBe(false);
    expect(isChargeAmountAllowed(-50, 1000)).toBe(false);
  });

  it("rejects non-finite amounts", () => {
    expect(isChargeAmountAllowed(Infinity, 1000)).toBe(false);
    expect(isChargeAmountAllowed(NaN, 1000)).toBe(false);
  });

  it("still allows a reasonable charge on a zero-total booking (e.g. a comped fare with a paid add-on)", () => {
    expect(isChargeAmountAllowed(200, 0)).toBe(true);
  });
});
