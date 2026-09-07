import { describe, it, expect } from "vitest";
import {
  buildPricingSnapshot,
  formatMoney,
  isSupportedCurrency,
  SUPPORTED_CURRENCIES,
  resolveExchangeRate,
  convertAmount,
  convertBookingPricing,
  convertToUsd,
  computeBookingProfitUsd,
  computeTotalSellingPriceUsd,
} from "../currency";

const USD_PRICING = {
  adultPrice: 500,
  childPrice: 350,
  infantPrice: 100,
  taxes: 120,
  serviceFee: 50,
  gratuity: 25,
  total: 1145,
};

// Compass Tools CRM — Exchange, Cancellation & Bulk Subscriber
// Improvements, Part 5: regression coverage for the exact formula
// exchange-builder.tsx uses to derive Adult Price from Exchange Fee +
// Fare Difference — `adultPriceUsd = convertToUsd(total, rate) / adults`.
// This lives inline in the component (not its own exported function), so
// this test documents/guards the underlying primitives it's built from
// rather than duplicating the component itself — the same "test the
// pieces, not a UI re-implementation" approach exchange.test.ts's own
// header comment already establishes for this workflow. The invariant
// that actually matters: converting the derived USD adultPrice back
// forward (adultPrice × adults, then convertAmount) must exactly
// reproduce the original customer-currency Total Exchange — this is what
// keeps "Adult Price = Total Exchange" true for a non-USD exchange, where
// naively setting adultPrice = exchangeFee + fareDifference (skipping the
// USD round-trip) would silently be wrong.
describe("Exchange Adult Price derivation — Total Exchange round-trips exactly for every supported currency", () => {
  const CASES: Array<{ currency: "USD" | "CAD" | "AUD" | "EUR" | "GBP"; rate: number; exchangeFee: number; fareDifference: number; adults: number }> = [
    { currency: "USD", rate: 1, exchangeFee: 200, fareDifference: 1800, adults: 1 },
    { currency: "EUR", rate: 0.92, exchangeFee: 150, fareDifference: 900, adults: 1 },
    { currency: "GBP", rate: 0.79, exchangeFee: 100, fareDifference: 650.5, adults: 2 },
    { currency: "AUD", rate: 1.52, exchangeFee: 250, fareDifference: -50, adults: 1 }, // a lower-priced replacement fare — Total Exchange can be legitimately smaller than the fee alone
  ];

  for (const { currency, rate, exchangeFee, fareDifference, adults } of CASES) {
    it(`${currency}: Adult Price (USD) × Adults, converted back, exactly reproduces Total Exchange`, () => {
      const effectiveRate = resolveExchangeRate(currency, currency === "USD" ? null : rate);
      const totalExchange = exchangeFee + fareDifference;

      const adultPriceUsd = convertToUsd(totalExchange, effectiveRate) / adults;
      const reconvertedTotal = convertAmount(adultPriceUsd * adults, effectiveRate);

      expect(reconvertedTotal).toBeCloseTo(totalExchange, 2);
      // The naive (wrong) approach this replaces: treating the customer-
      // currency total as if it were already USD. For any non-USD
      // currency this must differ from the correct derivation — confirms
      // the test would actually catch that regression, not just pass
      // trivially for every input.
      if (currency !== "USD") {
        expect(adultPriceUsd * adults).not.toBeCloseTo(totalExchange, 2);
      }
    });
  }

  it("never displays a non-USD Total Exchange with a bare '$' — formatMoney uses the real currency symbol", () => {
    expect(formatMoney(2000, "EUR")).toBe("€2,000.00");
    expect(formatMoney(2000, "GBP")).toBe("£2,000.00");
    expect(formatMoney(2000, "AUD")).toBe("A$2,000.00");
    expect(formatMoney(2000, "USD")).toBe("$2,000.00");
  });
});

describe("isSupportedCurrency", () => {
  it("accepts every currency in the supported list", () => {
    for (const c of SUPPORTED_CURRENCIES) expect(isSupportedCurrency(c)).toBe(true);
  });
  it("rejects an unsupported code", () => {
    expect(isSupportedCurrency("JPY")).toBe(false);
    expect(isSupportedCurrency("")).toBe(false);
  });
});

describe("buildPricingSnapshot", () => {
  it("USD is always exchange rate 1, values unchanged (beyond 2dp rounding)", () => {
    const snap = buildPricingSnapshot(USD_PRICING, "USD", 1);
    expect(snap.exchangeRate).toBe(1);
    expect(snap.total).toBe(1145);
    expect(snap.adultPrice).toBe(500);
  });

  it("USD ignores whatever rate is passed — always forced to 1", () => {
    const snap = buildPricingSnapshot(USD_PRICING, "USD", 0.5);
    expect(snap.exchangeRate).toBe(1);
    expect(snap.total).toBe(1145);
  });

  it("converts every price line by the given rate for a non-USD currency", () => {
    const snap = buildPricingSnapshot(USD_PRICING, "EUR", 0.92);
    expect(snap.currency).toBe("EUR");
    expect(snap.exchangeRate).toBe(0.92);
    expect(snap.adultPrice).toBe(460); // 500 * 0.92
    expect(snap.childPrice).toBe(322); // 350 * 0.92
    expect(snap.infantPrice).toBe(92); // 100 * 0.92
    expect(snap.taxes).toBe(110.4); // 120 * 0.92
    expect(snap.serviceFee).toBe(46); // 50 * 0.92
    expect(snap.gratuity).toBe(23); // 25 * 0.92
    expect(snap.total).toBe(1053.4); // 1145 * 0.92
  });

  it("rounds to exactly 2 decimal places even with a rate that produces float drift", () => {
    const snap = buildPricingSnapshot({ ...USD_PRICING, total: 999.99 }, "GBP", 0.79);
    // 999.99 * 0.79 = 789.9921 -> rounds to 789.99, not a float-tail value
    expect(snap.total).toBe(789.99);
    expect(Number.isInteger(snap.total * 100)).toBe(true);
  });

  it("is deterministic — same inputs always produce the same snapshot", () => {
    const a = buildPricingSnapshot(USD_PRICING, "CAD", 1.36);
    const b = buildPricingSnapshot(USD_PRICING, "CAD", 1.36);
    expect(a).toEqual(b);
  });
});

describe("formatMoney", () => {
  it("formats with the correct currency symbol and 2 decimal places", () => {
    expect(formatMoney(1234.5, "USD")).toBe("$1,234.50");
    expect(formatMoney(1234.5, "EUR")).toBe("€1,234.50");
    expect(formatMoney(1234.5, "GBP")).toBe("£1,234.50");
    expect(formatMoney(1234.5, "CAD")).toBe("C$1,234.50");
    expect(formatMoney(1234.5, "AUD")).toBe("A$1,234.50");
  });

  // Pass 27 — a negative amount (a loss-making sale's profit, or an
  // exchange's fareDifference on a lower-priced replacement fare — see
  // Quote.fareDifference's own schema doc comment) must put the minus sign
  // BEFORE the currency symbol ("-$150.00"), never after it
  // ("$-150.00", `toLocaleString`'s own default placement). This exact bug
  // was previously fixed only inside the internal sale-notification
  // email's own separate fmtSignedMoney() helper — never in this shared
  // formatter, which every CRM page (Commissions, Salesboard, Booking
  // Information) and every customer-facing exchange summary actually
  // calls, so the bug was still fully reproducible everywhere else.
  it("puts the minus sign before the currency symbol for a negative amount, never after it", () => {
    expect(formatMoney(-150, "USD")).toBe("-$150.00");
    expect(formatMoney(-150, "EUR")).toBe("-€150.00");
    expect(formatMoney(-150, "GBP")).toBe("-£150.00");
    expect(formatMoney(-150, "CAD")).toBe("-C$150.00");
    expect(formatMoney(-150, "AUD")).toBe("-A$150.00");
  });

  it("never produces the wrong '$-150.00' ordering for a negative amount", () => {
    expect(formatMoney(-150, "USD")).not.toBe("$-150.00");
  });

  it("zero is never shown as negative", () => {
    expect(formatMoney(0, "USD")).toBe("$0.00");
  });
});

describe("resolveExchangeRate", () => {
  it("USD is always exactly 1, ignoring whatever rate is stored", () => {
    expect(resolveExchangeRate("USD", 0.5)).toBe(1);
    expect(resolveExchangeRate("USD", null)).toBe(1);
    expect(resolveExchangeRate("USD", undefined)).toBe(1);
  });
  it("a non-USD currency uses its stored rate", () => {
    expect(resolveExchangeRate("AUD", 1.52)).toBe(1.52);
  });
  it("a non-USD currency with no stored rate defensively falls back to 1 rather than throwing", () => {
    expect(resolveExchangeRate("AUD", null)).toBe(1);
    expect(resolveExchangeRate("AUD", undefined)).toBe(1);
  });
});

describe("convertAmount", () => {
  it("multiplies and rounds to 2 decimal places", () => {
    expect(convertAmount(340, 1.52)).toBe(516.8);
  });
  it("matches buildPricingSnapshot's own rounding for the same inputs", () => {
    expect(convertAmount(999.99, 0.79)).toBe(789.99);
  });
});

describe("convertBookingPricing — the exact reported bug (quote sent in AUD, booking still showed USD)", () => {
  it("converts every booking pricing field by the quote's rate, matching the worked example", () => {
    // From the spec's own worked example: ticket cost A$364.80, gratuity
    // A$152.00, total A$516.80 — reverse-engineered to a $340 USD total.
    const usd = { ticketSubtotal: 240, taxes: 0, serviceFee: 0, gratuity: 100, total: 340 };
    const converted = convertBookingPricing(usd, 1.52);
    expect(converted.ticketSubtotal).toBe(364.8);
    expect(converted.gratuity).toBe(152);
    expect(converted.total).toBe(516.8);
  });

  it("a USD quote (rate 1) leaves every field numerically unchanged", () => {
    const usd = { ticketSubtotal: 240, taxes: 20, serviceFee: 10, gratuity: 100, total: 370 };
    expect(convertBookingPricing(usd, 1)).toEqual(usd);
  });

  it("does not double-convert — converting an already-converted breakdown again is a distinct, deliberate call, not something this function does implicitly", () => {
    const usd = { ticketSubtotal: 100, taxes: 0, serviceFee: 0, gratuity: 0, total: 100 };
    const oneRate = convertBookingPricing(usd, 1.52);
    const stillOneConversion = convertBookingPricing(usd, 1.52);
    expect(oneRate).toEqual(stillOneConversion);
    // Sanity: converting twice IS different from converting once — proving
    // the function has no hidden memoization that would mask a real
    // accidental-double-conversion bug at the call site.
    const twoConversions = convertBookingPricing(oneRate, 1.52);
    expect(twoConversions.total).not.toBe(oneRate.total);
  });
});

describe("convertToUsd", () => {
  it("reverses convertAmount for the same rate", () => {
    const converted = convertAmount(340, 1.52);
    expect(convertToUsd(converted, 1.52)).toBe(340);
  });
  it("a rate of 1 (USD) is a no-op", () => {
    expect(convertToUsd(516.8, 1)).toBe(516.8);
  });
});

describe("computeTotalSellingPriceUsd — adults/children/infants each times the quote's own USD per-passenger price", () => {
  it("sums all three passenger types", () => {
    // 2x$1,500 + 1x$900 + 1x$200 = $4,100 — the spec's own worked example.
    const total = computeTotalSellingPriceUsd({ adults: 2, adultPrice: 1500, children: 1, childPrice: 900, infants: 1, infantPrice: 200 });
    expect(total).toBe(4100);
  });

  it("passenger types with zero count contribute nothing even if a price is set", () => {
    const total = computeTotalSellingPriceUsd({ adults: 1, adultPrice: 1000, children: 0, childPrice: 500, infants: 0, infantPrice: 200 });
    expect(total).toBe(1000);
  });
});

describe("computeBookingProfitUsd — Total Selling Price minus Ticket Cost minus Taxes/Issuing Fee (both optional, 0 when blank)", () => {
  it("matches the spec's own worked example: $4,100 selling price, $3,000 ticket cost, $300 taxes, $50 issuing fee -> $750 profit", () => {
    const profit = computeBookingProfitUsd({ totalSellingPrice: 4100, fareAmount: 3000, taxAmount: 300, serviceFeeAmount: 50 });
    expect(profit).toBe(750);
  });

  it("taxes and issuing fee default to 0 when blank rather than blocking the calculation", () => {
    const profit = computeBookingProfitUsd({ totalSellingPrice: 4100, fareAmount: 3000, taxAmount: undefined, serviceFeeAmount: undefined });
    expect(profit).toBe(1100);
  });

  it("returns undefined only when Ticket Cost itself is not yet known", () => {
    expect(computeBookingProfitUsd({ totalSellingPrice: 1000, fareAmount: null, taxAmount: 100, serviceFeeAmount: 50 })).toBeUndefined();
    expect(computeBookingProfitUsd({ totalSellingPrice: 1000, fareAmount: undefined, taxAmount: 100, serviceFeeAmount: 50 })).toBeUndefined();
  });

  // Explicit pre-launch QA requirement: a loss-making booking (ticket cost +
  // taxes + issuing fee exceeding the selling price) is a real, valid
  // business outcome and must be reported as negative — never silently
  // clamped to zero, which would hide a real loss from Commissions/
  // Salesboard/the internal notification.
  it("stays negative for a loss-making booking — never clamped to zero", () => {
    const profit = computeBookingProfitUsd({ totalSellingPrice: 500, fareAmount: 600, taxAmount: 50, serviceFeeAmount: 20 });
    expect(profit).toBe(-170);
    expect(profit).toBeLessThan(0);
  });

  it("is exactly zero for a break-even booking (not treated as a special/undefined case)", () => {
    const profit = computeBookingProfitUsd({ totalSellingPrice: 670, fareAmount: 600, taxAmount: 50, serviceFeeAmount: 20 });
    expect(profit).toBe(0);
  });

  it("adults + children + infants each contribute to selling price at their own per-type rate", () => {
    const sellingPrice = computeTotalSellingPriceUsd({
      adults: 2,
      adultPrice: 500,
      children: 1,
      childPrice: 300,
      infants: 1,
      infantPrice: 50,
    });
    expect(sellingPrice).toBe(2 * 500 + 1 * 300 + 1 * 50); // 1350
    expect(computeBookingProfitUsd({ totalSellingPrice: sellingPrice, fareAmount: 1000, taxAmount: 0, serviceFeeAmount: 0 })).toBe(350);
  });
});
