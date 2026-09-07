/**
 * Sanity cap for a manual charge against a booking's saved payment method.
 * Authorized agents can still charge legitimate add-ons/fare differences,
 * just not an arbitrary unbounded amount a fat-fingered input could produce.
 */
export function maxReasonableChargeAmount(bookingTotal: number): number {
  return bookingTotal * 5 + 5000;
}

export function isChargeAmountAllowed(amount: number, bookingTotal: number): boolean {
  return amount > 0 && Number.isFinite(amount) && amount <= maxReasonableChargeAmount(bookingTotal);
}
