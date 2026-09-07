// Single source of truth for quote currency conversion — the supported
// currency list, display symbols, and the pure conversion math. Used by the
// quote builder (agent selects currency + rate), sendQuote (freezes the
// snapshot), and every customer-facing renderer (email, View Deal, booking
// page) that reads the frozen snapshot back out.

import { round2 } from "@/lib/pricing";

export const SUPPORTED_CURRENCIES = ["USD", "CAD", "AUD", "EUR", "GBP"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export const CURRENCY_SYMBOLS: Record<SupportedCurrency, string> = {
  USD: "$",
  CAD: "C$",
  AUD: "A$",
  EUR: "€",
  GBP: "£",
};

export const CURRENCY_LABELS: Record<SupportedCurrency, string> = {
  USD: "USD — US Dollar",
  CAD: "CAD — Canadian Dollar",
  AUD: "AUD — Australian Dollar",
  EUR: "EUR — Euro",
  GBP: "GBP — British Pound",
};

// Reference starting points only — there is no live FX feed wired up here.
// The agent-facing UI must always show these as an editable, overridable
// default (never a silently-trusted live rate) and prompt the agent to
// verify the current rate before sending. USD's own rate is always exactly
// 1 and is never itself editable.
export const DEFAULT_EXCHANGE_RATES: Record<SupportedCurrency, number> = {
  USD: 1,
  CAD: 1.36,
  AUD: 1.52,
  EUR: 0.92,
  GBP: 0.79,
};

/**
 * Pass 27 — a currency-symbol-prefixed amount that may legitimately be
 * negative (profit on a loss-making sale; a negative fareDifference on an
 * exchange proposal — "a lower-priced replacement fare", per
 * Quote.fareDifference's own schema doc comment) must format the sign
 * BEFORE the symbol ("-$150.00"), never after it. `${symbol}${amount.toLocaleString(...)}`
 * alone produces "$-150.00" for a negative amount, because
 * toLocaleString() puts the minus sign on the number itself — this bug was
 * previously fixed ONLY inside the internal sale-notification email's own
 * bespoke fmtSignedMoney() helper (src/server/email/templates.ts), never
 * here in the one shared helper every CRM page (Commissions, Salesboard,
 * the Booking Information card) and every customer-facing page (quote/
 * booking exchange summaries) actually calls — so the bug was still fully
 * reproducible everywhere except that one email. Fixed at the source
 * instead of adding yet another parallel formatter.
 */
export function formatMoney(amount: number, currency: SupportedCurrency): string {
  const symbol = CURRENCY_SYMBOLS[currency];
  const abs = Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return amount < 0 ? `-${symbol}${abs}` : `${symbol}${abs}`;
}

export type UsdPricing = {
  adultPrice: number;
  childPrice: number;
  infantPrice: number;
  taxes: number;
  serviceFee: number;
  gratuity: number;
  total: number;
};

export type PricingSnapshot = UsdPricing & {
  currency: SupportedCurrency;
  exchangeRate: number;
};

/**
 * Freezes a customer-facing price breakdown: converts every USD price line
 * by `exchangeRate` and rounds to 2 decimal places, same rounding rule
 * calculatePricing() uses for the USD math (see src/lib/pricing.ts) so
 * neither pipeline drifts from the other by a different rounding
 * convention. The result is meant to be persisted as-is (Quote.pricingSnapshot)
 * and never recomputed from live data once a quote has been sent.
 */
/**
 * Reads back a Quote.pricingSnapshot JSON value as a typed PricingSnapshot.
 * Falls back to the raw USD figures at rate 1 when no snapshot exists yet
 * (a quote that hasn't been through sendQuote() — customer-facing pages are
 * normally only reachable after a send, but this keeps them from crashing
 * if reached earlier, e.g. an agent previewing the link before sending).
 */
export function resolvePricingSnapshot(pricingSnapshot: unknown, fallbackUsd: UsdPricing): PricingSnapshot {
  if (pricingSnapshot && typeof pricingSnapshot === "object") {
    const snap = pricingSnapshot as Partial<PricingSnapshot>;
    if (typeof snap.currency === "string" && isSupportedCurrency(snap.currency) && typeof snap.total === "number") {
      return snap as PricingSnapshot;
    }
  }
  return { ...fallbackUsd, currency: "USD", exchangeRate: 1 };
}

/**
 * Normalizes a Quote's stored currency + exchangeRate into the actual rate
 * to multiply by — USD is always exactly 1 regardless of whatever's in the
 * exchangeRate column (it's null for a USD quote), and a missing/null rate
 * on a non-USD quote falls back to 1 defensively rather than throwing.
 */
export function resolveExchangeRate(currency: string, exchangeRate: number | null | undefined): number {
  if (currency === "USD") return 1;
  return exchangeRate ?? 1;
}

/** Converts a single USD amount by an already-resolved rate, rounded to 2dp
 * — the one primitive every currency conversion in this app is built from. */
export function convertAmount(usdAmount: number, rate: number): number {
  return round2(usdAmount * rate);
}

/**
 * Converts a Booking's own pricing breakdown (ticket subtotal / taxes /
 * service fee / gratuity / total — the shape Booking's own columns use,
 * distinct from UsdPricing's per-passenger-type prices) by a quote's
 * exchange rate. Used by submitBooking so the booking's persisted amounts,
 * payment allocation, and everything downstream are denominated in the
 * quote's own currency, never recalculated with a different rate later.
 */
export type BookingPricingBreakdown = { ticketSubtotal: number; taxes: number; serviceFee: number; gratuity: number; total: number };

export function convertBookingPricing(usd: BookingPricingBreakdown, rate: number): BookingPricingBreakdown {
  return {
    ticketSubtotal: convertAmount(usd.ticketSubtotal, rate),
    taxes: convertAmount(usd.taxes, rate),
    serviceFee: convertAmount(usd.serviceFee, rate),
    gratuity: convertAmount(usd.gratuity, rate),
    total: convertAmount(usd.total, rate),
  };
}

/**
 * Reverses convertAmount()/convertBookingPricing() — recovers the original
 * USD amount from a value that was previously converted forward by `rate`.
 * Needed because Booking.totalAmount/gratuityAmount are persisted in the
 * quote's own customer-facing currency (see submitBooking's use of
 * convertBookingPricing), while Booking.fareAmount/taxAmount/
 * serviceFeeAmount (entered by a Ticketing Agent) are always USD — the same
 * "agent enters/tracks prices in USD internally" convention as Quote's own
 * pricing fields (see Quote.currency's schema doc comment). Any USD-only
 * calculation mixing the two (e.g. booking profit) must convert the
 * customer-currency figure back to USD first, or it silently produces a
 * wrong number for every non-USD quote. A USD quote has rate 1, so this is
 * a no-op for the common case.
 */
export function convertToUsd(amount: number, rate: number): number {
  return round2(amount / rate);
}

/**
 * Total Selling Price: the sum of what the customer is being charged for
 * the seats themselves — adults/children/infants each multiplied by the
 * quote's own per-passenger USD price. Deliberately excludes gratuity (a
 * customer pass-through tip, not agency revenue) and does not need any
 * currency conversion — Quote.adultPrice/childPrice/infantPrice are always
 * tracked in USD internally (see convertToUsd's doc comment for the same
 * convention elsewhere).
 */
export function computeTotalSellingPriceUsd(params: {
  adults: number;
  adultPrice: number;
  children: number;
  childPrice: number;
  infants: number;
  infantPrice: number;
}): number {
  return round2(params.adults * params.adultPrice + params.children * params.childPrice + params.infants * params.infantPrice);
}

/**
 * The one authoritative booking-profit formula: Total Selling Price minus
 * Ticket Cost (fareAmount, required) minus Taxes and Issuing Fee (both
 * optional — treated as 0 when blank, never blocking the calculation).
 * Returns undefined only when Ticket Cost itself isn't known yet — a
 * booking with no ticket cost entered has no profit to derive.
 */
export function computeBookingProfitUsd(params: {
  totalSellingPrice: number;
  fareAmount: number | null | undefined;
  taxAmount: number | null | undefined;
  serviceFeeAmount: number | null | undefined;
}): number | undefined {
  if (params.fareAmount == null) return undefined;
  const taxes = params.taxAmount ?? 0;
  const issuingFee = params.serviceFeeAmount ?? 0;
  return round2(params.totalSellingPrice - params.fareAmount - taxes - issuingFee);
}

export function buildPricingSnapshot(usd: UsdPricing, currency: SupportedCurrency, exchangeRate: number): PricingSnapshot {
  const rate = currency === "USD" ? 1 : exchangeRate;
  const convert = (n: number) => round2(n * rate);
  return {
    currency,
    exchangeRate: rate,
    adultPrice: convert(usd.adultPrice),
    childPrice: convert(usd.childPrice),
    infantPrice: convert(usd.infantPrice),
    taxes: convert(usd.taxes),
    serviceFee: convert(usd.serviceFee),
    gratuity: convert(usd.gratuity),
    total: convert(usd.total),
  };
}
