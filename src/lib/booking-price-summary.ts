import { computeTotalSellingPriceUsd, convertAmount } from "@/lib/currency";

/**
 * The CUSTOMER-FACING price summary of a booking — what the customer saw and
 * signed on the booking form (Ticket cost, Taxes, Service fee, Gratuity,
 * Total), in the quote's own customer currency.
 *
 * It is derived only from the quote's selling prices and the booking's signed
 * gratuity/total. It deliberately never reads Booking.fareAmount /
 * taxAmount / serviceFeeAmount: those are the Ticketing Agent's INTERNAL
 * expenditure figures ("Ticket Nett Cost", internal taxes and issuing fee),
 * a different financial concept that must neither show up in, nor overwrite,
 * the signed summary when an agent edits their own costs.
 */
export function customerPriceSummary(params: {
  adults: number;
  adultPrice: number;
  children: number;
  childPrice: number;
  infants: number;
  infantPrice: number;
  taxes: number;
  serviceFee: number;
  /** The quote's currency and its USD→currency rate (1 for USD). */
  currency: string;
  exchangeRate: number | null | undefined;
  /** Booking.gratuityAmount / Booking.totalAmount — already in the customer currency, as signed. */
  gratuityAmount: number;
  totalAmount: number;
}) {
  const rate = params.currency === "USD" ? 1 : (params.exchangeRate ?? 1);
  const ticketCostUsd = computeTotalSellingPriceUsd({
    adults: params.adults,
    adultPrice: params.adultPrice,
    children: params.children,
    childPrice: params.childPrice,
    infants: params.infants,
    infantPrice: params.infantPrice,
  });
  return {
    ticketCost: convertAmount(ticketCostUsd, rate),
    taxes: convertAmount(params.taxes, rate),
    serviceFee: convertAmount(params.serviceFee, rate),
    gratuity: params.gratuityAmount,
    total: params.totalAmount,
  };
}
