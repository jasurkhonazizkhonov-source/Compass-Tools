// Card-number/expiry/CVV formatting and validation. This module is shared
// by the client (for input formatting/UX feedback) and the server (for the
// authoritative check) — but client-side use is UX only, never a security
// control: submitBooking() independently re-validates everything
// server-side regardless of what the browser already checked, since a
// client can always be bypassed.

export type CardBrand = "Visa" | "Mastercard" | "American Express" | "Discover" | "Unknown";

/** Strips everything but digits — the only sanitization applied to a raw
 * card-number input before validation/formatting. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Detects card brand from the standard IATA/ISO prefix ranges. Purely
 * cosmetic (badge/icon selection) — never used as a security or acceptance
 * decision. */
export function detectCardBrand(cardNumber: string): CardBrand {
  const digits = digitsOnly(cardNumber);
  if (/^4/.test(digits)) return "Visa";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return "Mastercard";
  if (/^3[47]/.test(digits)) return "American Express";
  if (/^6(011|5)/.test(digits)) return "Discover";
  return "Unknown";
}

/** Groups digits into "4111 1111 1111 1111" — American Express uses a
 * 4-6-5 grouping instead of 4-4-4-4. */
export function formatCardNumber(value: string): string {
  const digits = digitsOnly(value).slice(0, 19);
  if (detectCardBrand(digits) === "American Express") {
    const parts = [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10, 15)].filter(Boolean);
    return parts.join(" ");
  }
  const groups = digits.match(/.{1,4}/g) ?? [];
  return groups.join(" ");
}

/** Luhn checksum — catches typos, not fraud. A necessary but nowhere-near-
 * sufficient check; the server performs the exact same check independently
 * rather than trusting a "the frontend already validated it" flag. */
export function luhnCheck(cardNumber: string): boolean {
  const digits = digitsOnly(cardNumber);
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export function isValidCardNumber(cardNumber: string): boolean {
  return luhnCheck(cardNumber);
}

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

/** 3 digits for every brand except American Express, which uses 4. */
export function isValidCvvFormat(cvv: string, brand: CardBrand): boolean {
  const digits = digitsOnly(cvv);
  const expectedLength = brand === "American Express" ? 4 : 3;
  return digits.length === expectedLength;
}

export function lastFour(cardNumber: string): string {
  return digitsOnly(cardNumber).slice(-4);
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
