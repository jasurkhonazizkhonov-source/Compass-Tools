// Small, provider-neutral helpers about a card's DISPLAY metadata. Compass Tools
// never handles a card number or security code, so there is deliberately no
// card-number formatting, Luhn check or brand detection from digits here — the
// payment provider's hosted fields do all of that, and report back the brand,
// last four digits and expiry.

export type CardBrand = "Visa" | "Mastercard" | "American Express" | "Discover" | "Unknown";

/** Whether an expiry (month 1-12, four-digit year) is still valid this month. */
export function isValidExpiry(month: number, year: number): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(year)) return false;
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  if (year < currentYear) return false;
  if (year === currentYear && month < currentMonth) return false;
  if (year > currentYear + 20) return false; // sanity ceiling, not a real card rule
  return true;
}

/** Whether a set of per-card allocated amounts exactly covers a booking's
 * total — this app has no partial-payment business rule, so anything other
 * than an exact match (within a cent of floating-point slack) is invalid,
 * whether under- or over-allocated. Pulled out as a pure function so the
 * allocation rule itself is unit-testable without exercising all of
 * submitBooking()'s other side effects (DB writes, email sends, etc.). */
export function isPaymentAllocationValid(amounts: number[], total: number): boolean {
  const allocated = amounts.reduce((sum, a) => sum + a, 0);
  return Math.abs(allocated - total) <= 0.01;
}
