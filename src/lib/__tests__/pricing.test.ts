import { describe, it, expect } from "vitest";
import { calculatePricing } from "../pricing";

describe("calculatePricing", () => {
  it("calculates adults only", () => {
    const r = calculatePricing({
      adults: 2, children: 0, infants: 0,
      adultPrice: 450.5, childPrice: 0, infantPrice: 0,
      taxes: 80, serviceFee: 25, gratuity: 0,
    });
    expect(r.adultSubtotal).toBe(901);
    expect(r.ticketSubtotal).toBe(901);
    expect(r.total).toBe(1006);
  });

  it("calculates adults + children", () => {
    const r = calculatePricing({
      adults: 2, children: 1, infants: 0,
      adultPrice: 500, childPrice: 350, infantPrice: 0,
      taxes: 90, serviceFee: 0, gratuity: 0,
    });
    expect(r.childSubtotal).toBe(350);
    expect(r.ticketSubtotal).toBe(1350);
    expect(r.total).toBe(1440);
  });

  it("calculates adults + infants", () => {
    const r = calculatePricing({
      adults: 1, children: 0, infants: 1,
      adultPrice: 600, childPrice: 0, infantPrice: 75,
      taxes: 40, serviceFee: 0, gratuity: 0,
    });
    expect(r.infantSubtotal).toBe(75);
    expect(r.total).toBe(715);
  });

  it("applies gratuity on top of the ticket total", () => {
    const r = calculatePricing({
      adults: 1, children: 0, infants: 0,
      adultPrice: 1000, childPrice: 0, infantPrice: 0,
      taxes: 100, serviceFee: 50, gratuity: 150,
    });
    expect(r.total).toBe(1300);
  });

  it("avoids float drift across many passengers", () => {
    const r = calculatePricing({
      adults: 3, children: 2, infants: 1,
      adultPrice: 333.33, childPrice: 199.99, infantPrice: 49.99,
      taxes: 123.45, serviceFee: 15, gratuity: 0,
    });
    expect(Number.isFinite(r.total)).toBe(true);
    expect(r.total).toBe(round(3 * 333.33 + 2 * 199.99 + 49.99 + 123.45 + 15));
  });
});

function round(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
