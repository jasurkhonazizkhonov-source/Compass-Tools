"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { formatCardNumber, detectCardBrand, digitsOnly } from "@/lib/card-validation";
import { formatMoney, type SupportedCurrency } from "@/lib/currency";
import { X } from "lucide-react";

export type CardFormState = {
  cardholderName: string;
  cardNumber: string; // formatted for display, with spaces — digits-only before submit
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  amount: string;
};

export const EMPTY_CARD_FORM: CardFormState = {
  cardholderName: "",
  cardNumber: "",
  expiryMonth: "",
  expiryYear: "",
  cvv: "",
  amount: "",
};

/**
 * Native CRM-style card collection — plain input boxes plus a live
 * decorative physical-card preview above them, no external JavaScript
 * loaded, no hosted iframe, no redirect. Card data goes directly to this
 * app's own submitBooking() action (see its comment for where the CVV is
 * validated and then discarded, never persisted).
 */
export function CardPaymentSection({
  value,
  onChange,
  label,
  onRemove,
  fixedAmount,
  currency,
}: {
  value: CardFormState;
  onChange: (next: CardFormState) => void;
  label: string;
  onRemove?: () => void;
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
}) {
  const brand = detectCardBrand(value.cardNumber);
  const displayNumber = value.cardNumber || "•••• •••• •••• ••••";
  const displayName = value.cardholderName.trim().toUpperCase() || "CARDHOLDER NAME";
  const displayExpiry = value.expiryMonth && value.expiryYear ? `${value.expiryMonth.padStart(2, "0")}/${value.expiryYear.slice(-2)}` : "MM/YY";

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
            // Pass 22 fix — 28px visual size is fine for a staff/desktop
            // CRM control but too small a touch target on this
            // customer-facing, mobile-visible booking form; the invisible
            // after:-inset-3 hit-area expansion (matching Checkbox's own
            // established idiom, src/components/ui/checkbox.tsx) brings
            // the effective tappable area to ~44px without changing how
            // the button actually looks.
            className="relative text-muted-foreground hover:text-destructive after:absolute after:-inset-3"
            aria-label={`Remove ${label}`}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Decorative physical-card preview — updates live as the customer types. Presentation only; the accessible inputs below are the real form controls. */}
      <div
        aria-hidden="true"
        className="rounded-xl p-5 text-white shadow-md"
        style={{ background: "linear-gradient(135deg, #1e293b 0%, #334155 60%, #1e293b 100%)" }}
      >
        <div className="flex items-center justify-between">
          <CardBrandLogo brand={brand} />
        </div>
        <p className="mt-6 font-mono text-lg tracking-widest">{displayNumber}</p>
        <div className="mt-4 flex items-end justify-between">
          <p className="text-xs tracking-wide truncate max-w-[70%]">{displayName}</p>
          <p className="text-xs tracking-wide">{displayExpiry}</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Cardholder Name *</Label>
        <Input
          value={value.cardholderName}
          onChange={(e) => onChange({ ...value, cardholderName: e.target.value })}
          placeholder="Full name as shown on card"
          autoComplete="cc-name"
        />
      </div>
      <div className="space-y-1.5">
        <Label>Card Number *</Label>
        <div className="relative">
          <Input
            value={value.cardNumber}
            onChange={(e) => onChange({ ...value, cardNumber: formatCardNumber(e.target.value) })}
            placeholder="Card number"
            inputMode="numeric"
            autoComplete="cc-number"
            maxLength={23}
            className="pr-16"
          />
          {brand !== "Unknown" && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              <CardBrandLogo brand={brand} />
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Expiration *</Label>
          <div className="flex items-center gap-1.5">
            <Input
              value={value.expiryMonth}
              onChange={(e) => onChange({ ...value, expiryMonth: digitsOnly(e.target.value).slice(0, 2) })}
              placeholder="MM"
              inputMode="numeric"
              autoComplete="cc-exp-month"
              maxLength={2}
              className="w-16 shrink-0 text-center"
            />
            <span className="text-muted-foreground">/</span>
            <Input
              value={value.expiryYear}
              onChange={(e) => onChange({ ...value, expiryYear: digitsOnly(e.target.value).slice(0, 4) })}
              placeholder="YYYY"
              inputMode="numeric"
              autoComplete="cc-exp-year"
              maxLength={4}
              className="w-20 shrink-0 text-center"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>CVV *</Label>
          <Input
            value={value.cvv}
            onChange={(e) => onChange({ ...value, cvv: digitsOnly(e.target.value).slice(0, 4) })}
            placeholder="***"
            inputMode="numeric"
            autoComplete="cc-csc"
            type="password"
            maxLength={4}
            className="w-24"
          />
        </div>
      </div>
      {fixedAmount !== undefined ? (
        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
          <span className="text-sm text-muted-foreground">Amount charged</span>
          <span className="text-sm font-semibold tabular-nums">{formatMoney(fixedAmount, currency)}</span>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label>Amount to Charge ({currency}) *</Label>
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
}

export function PaymentConsentCheckbox({ checked, onChange, companyName }: { checked: boolean; onChange: (v: boolean) => void; companyName: string }) {
  return (
    <label className="flex items-start gap-2 text-xs text-muted-foreground">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <span>I authorize {companyName} to securely store this payment method for this booking&apos;s ticketing and supplier workflow.</span>
    </label>
  );
}
