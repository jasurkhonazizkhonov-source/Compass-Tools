import { describe, it, expect } from "vitest";
import { customerPriceSummary } from "../booking-price-summary";

// The customer-facing Price Summary (what the customer signed) and the
// internal Ticket Nett Cost (what the ticketing agent enters) are different
// financial concepts. The summary is derived ONLY from the quote's selling
// prices and the booking's signed gratuity/total — so entering or editing a
// nett cost can never overwrite it.

const QUOTE = { adults: 1, adultPrice: 1800, children: 0, childPrice: 0, infants: 0, infantPrice: 0, taxes: 0, serviceFee: 0 };

describe("customerPriceSummary", () => {
  it("shows the signed figures: Ticket cost 1,800 + Gratuity 200 = Total 2,000", () => {
    const s = customerPriceSummary({ ...QUOTE, currency: "USD", exchangeRate: null, gratuityAmount: 200, totalAmount: 2000 });
    expect(s).toEqual({ ticketCost: 1800, taxes: 0, serviceFee: 0, gratuity: 200, total: 2000 });
  });

  it("has no way to take a nett cost — its inputs do not include Booking.fareAmount/taxAmount/serviceFeeAmount at all", () => {
    const withNettCost = customerPriceSummary({ ...QUOTE, currency: "USD", exchangeRate: null, gratuityAmount: 200, totalAmount: 2000, ...({ fareAmount: 1450 } as object) });
    const without = customerPriceSummary({ ...QUOTE, currency: "USD", exchangeRate: null, gratuityAmount: 200, totalAmount: 2000 });
    expect(withNettCost).toEqual(without);
    expect(withNettCost.ticketCost).toBe(1800); // never 1,450
  });

  it("multiplies per-passenger prices and includes taxes and service fee at the quote's own rate for a non-USD quote", () => {
    const s = customerPriceSummary({
      adults: 2,
      adultPrice: 500,
      children: 1,
      childPrice: 400,
      infants: 1,
      infantPrice: 100,
      taxes: 50,
      serviceFee: 20,
      currency: "AUD",
      exchangeRate: 1.5,
      gratuityAmount: 30,
      totalAmount: 2175,
    });
    // tickets: 2*500 + 400 + 100 = 1500 USD → 2250 AUD
    expect(s.ticketCost).toBe(1500 * 1.5);
    expect(s.taxes).toBe(75);
    expect(s.serviceFee).toBe(30);
    expect(s.gratuity).toBe(30); // already in the customer currency
    expect(s.total).toBe(2175); // exactly as signed
  });

  it("a USD quote ignores any stored exchange rate", () => {
    const s = customerPriceSummary({ ...QUOTE, currency: "USD", exchangeRate: 1.7, gratuityAmount: 0, totalAmount: 1800 });
    expect(s.ticketCost).toBe(1800);
  });
});
