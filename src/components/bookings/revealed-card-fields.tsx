export type RevealedCardData = {
  cardholderName: string;
  pan: string;
  cardBrand: string | null;
  expiryMonth: number;
  expiryYear: number;
};

function Field({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium font-mono break-all">{value}</p>
    </div>
  );
}

/**
 * The complete, authorised card reveal: cardholder name, full card number and
 * expiration (plus the brand when known). There is deliberately no security code
 * (CVV/CVC) here or anywhere in the app — it is never stored, so it can never be
 * shown. Rendered only inside a useTimedReveal container, which holds the data in
 * component state, hides it on a timer / tab change / blur / unmount, and blocks
 * copy, cut and the context menu on the surrounding region.
 */
export function RevealedCardFields({ card }: { card: RevealedCardData }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="revealed-card-fields">
      <Field label="Cardholder Name" value={card.cardholderName} className="sm:col-span-2" />
      <Field label="Card Number" value={card.pan.replace(/(.{4})/g, "$1 ").trim()} className="sm:col-span-2" />
      <Field label="Expiration" value={`${String(card.expiryMonth).padStart(2, "0")}/${card.expiryYear}`} />
      {card.cardBrand && <Field label="Card Brand" value={card.cardBrand} />}
    </div>
  );
}
