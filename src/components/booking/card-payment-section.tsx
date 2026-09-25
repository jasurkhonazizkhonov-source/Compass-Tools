"use client";

import { forwardRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { SecureCardFields, type SecureCardHandle } from "@/components/payments/secure-card-fields";
import { cardBrandFromProvider } from "@/components/payments/brand";
import { formatMoney, type SupportedCurrency } from "@/lib/currency";
import { X } from "lucide-react";

/**
 * Everything the form itself holds about one payment method. There is no card
 * number, expiry or security code here — those live only inside the payment
 * provider's iframes. `slotKey` makes provider setup idempotent across
 * retries; `setupIntentId` is the opaque reference to the vaulted card once
 * the provider has confirmed it (kept so a retry after a later failure does
 * not ask the customer to type the card again).
 */
export type CardFormState = {
  cardholderName: string;
  amount: string;
  slotKey: string;
  setupIntentId: string | null;
};

export function newCardForm(): CardFormState {
  return { cardholderName: "", amount: "", slotKey: crypto.randomUUID(), setupIntentId: null };
}

/**
 * Card collection through the payment provider's hosted fields. The card
 * number, expiry and security code are typed into the provider's iframes and
 * sent straight to the provider; this app receives only an opaque reference
 * after the customer submits, and stores only that reference plus the brand,
 * last four digits and expiry the provider reports back.
 */
export const CardPaymentSection = forwardRef<
  SecureCardHandle,
  {
    value: CardFormState;
    onChange: (next: CardFormState) => void;
    label: string;
    onRemove?: () => void;
    publishableKey: string;
    /** When set (the single-payment-method case), the amount is the whole
     * booking total and isn't something the customer should have to type in
     * themselves — render it as a fixed, read-only line instead of an
     * editable input. Omit for the multi-card case, where each card needs an
     * editable amount so the customer can split the total across cards. */
    fixedAmount?: number;
    /** The booking's currency (inherited from the quote) — every amount
     * shown here, fixed or editable, is denominated in this, never a
     * hardcoded USD. */
    currency: SupportedCurrency;
  }
>(function CardPaymentSection({ value, onChange, label, onRemove, publishableKey, fixedAmount, currency }, ref) {
  const [brand, setBrand] = useState<string>("unknown");
  const displayName = value.cardholderName.trim().toUpperCase() || "CARDHOLDER NAME";
  const locked = value.setupIntentId !== null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p role="heading" aria-level={3} className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
        {onRemove && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onRemove}
            // 28px visual size is fine for a staff/desktop CRM control but too
            // small a touch target on this customer-facing, mobile-visible
            // form; the invisible after:-inset-3 hit-area expansion brings the
            // effective tappable area to ~44px without changing how it looks.
            className="relative text-muted-foreground hover:text-destructive after:absolute after:-inset-3"
            aria-label={`Remove ${label}`}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Decorative preview — presentation only. It can show the brand the
          provider detected and the name typed below; it never shows digits,
          because this page never has them. */}
      <div
        aria-hidden="true"
        className="rounded-xl p-5 text-white shadow-md"
        style={{ background: "linear-gradient(135deg, #1e293b 0%, #334155 60%, #1e293b 100%)" }}
      >
        <div className="flex items-center justify-between">
          <CardBrandLogo brand={cardBrandFromProvider(brand)} />
        </div>
        <p className="mt-6 font-mono text-lg tracking-widest">•••• •••• •••• ••••</p>
        <div className="mt-4 flex items-end justify-between">
          <p className="text-xs tracking-wide truncate max-w-[70%]">{displayName}</p>
          <p className="text-xs tracking-wide">MM/YY</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Cardholder Name *</Label>
        <Input
          value={value.cardholderName}
          onChange={(e) => onChange({ ...value, cardholderName: e.target.value })}
          placeholder="Full name as shown on card"
          autoComplete="cc-name"
          disabled={locked}
        />
      </div>

      {locked ? (
        <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Your card was securely verified. It will not be charged until you are contacted by your travel agent.
        </p>
      ) : (
        <SecureCardFields ref={ref} publishableKey={publishableKey} onBrandChange={setBrand} />
      )}

      {fixedAmount !== undefined ? (
        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
          <span className="text-sm text-muted-foreground">Amount authorized</span>
          <span className="text-sm font-semibold tabular-nums">{formatMoney(fixedAmount, currency)}</span>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label>Amount for this card ({currency}) *</Label>
          <Input
            value={value.amount}
            onChange={(e) => onChange({ ...value, amount: e.target.value.replace(/[^0-9.]/g, "") })}
            placeholder="0.00"
            inputMode="decimal"
            className="w-40"
          />
        </div>
      )}
    </div>
  );
});

export function PaymentConsentCheckbox({ checked, onChange, companyName }: { checked: boolean; onChange: (v: boolean) => void; companyName: string }) {
  return (
    <label className="flex items-start gap-2 text-xs text-muted-foreground">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <span>I authorize {companyName} to securely save this payment method with its payment provider for this booking, and to charge it for this booking&apos;s ticketing when authorized staff request it.</span>
    </label>
  );
}
