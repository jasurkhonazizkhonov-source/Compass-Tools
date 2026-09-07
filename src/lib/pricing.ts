// Server-side-safe pricing calculation. All amounts are decimal strings /
// numbers rounded to 2 places at every step to avoid float drift; Prisma
// stores the persisted values as Decimal(10,2).

export type PricingInput = {
  adults: number;
  children: number;
  infants: number;
  adultPrice: number;
  childPrice: number;
  infantPrice: number;
  taxes: number;
  serviceFee: number;
  gratuity: number;
};

export type PricingBreakdown = {
  adultSubtotal: number;
  childSubtotal: number;
  infantSubtotal: number;
  ticketSubtotal: number;
  taxes: number;
  serviceFee: number;
  gratuity: number;
  total: number;
};

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function calculatePricing(input: PricingInput): PricingBreakdown {
  const adultSubtotal = round2(input.adults * input.adultPrice);
  const childSubtotal = round2(input.children * input.childPrice);
  const infantSubtotal = round2(input.infants * input.infantPrice);
  const ticketSubtotal = round2(adultSubtotal + childSubtotal + infantSubtotal);
  const taxes = round2(input.taxes);
  const serviceFee = round2(input.serviceFee);
  const gratuity = round2(input.gratuity);
  const total = round2(ticketSubtotal + taxes + serviceFee + gratuity);

  return { adultSubtotal, childSubtotal, infantSubtotal, ticketSubtotal, taxes, serviceFee, gratuity, total };
}

export const GRATUITY_PRESETS = [25, 50, 100, 150, 200, 250, 300] as const;
