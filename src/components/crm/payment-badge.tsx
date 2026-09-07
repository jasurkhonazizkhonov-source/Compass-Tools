import { CreditCard } from "lucide-react";

/**
 * Renders only display-safe payment info: brand + last 4 + expiry.
 * Never accepts or renders a CVV or full card number — there is no prop
 * for either, by design.
 */
export function PaymentBadge({
  cardBrand,
  cardLast4,
  expiryMonth,
  expiryYear,
}: {
  cardBrand: string | null | undefined;
  cardLast4: string | null | undefined;
  expiryMonth: number | null | undefined;
  expiryYear: number | null | undefined;
}) {
  if (!cardLast4) return <span className="text-muted-foreground">No payment method on file</span>;

  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="font-medium">
        {cardBrand || "Card"} •••• {cardLast4}
      </span>
      {expiryMonth && expiryYear && (
        <span className="text-muted-foreground">
          Expires {String(expiryMonth).padStart(2, "0")}/{String(expiryYear).slice(-2)}
        </span>
      )}
    </span>
  );
}
