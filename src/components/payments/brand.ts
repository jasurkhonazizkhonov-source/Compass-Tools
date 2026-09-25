import type { CardBrand } from "@/lib/card-validation";

/** Maps a payment provider's lowercase brand id to the badge the UI knows how to draw. */
export function cardBrandFromProvider(brand: string | null | undefined): CardBrand {
  switch ((brand ?? "").toLowerCase()) {
    case "visa":
      return "Visa";
    case "mastercard":
      return "Mastercard";
    case "amex":
    case "american express":
      return "American Express";
    case "discover":
      return "Discover";
    default:
      return "Unknown";
  }
}
