"use client";

import { toast } from "sonner";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { updatePaymentMethodWorkflowStatus } from "@/server/actions/payment-methods";
import { formatMoney, type SupportedCurrency } from "@/lib/currency";
import { cardBrandFromProvider } from "@/components/payments/brand";
import type { PaymentMethodStatus, PaymentVaultStatus, PaymentWorkflowStatus } from "@/generated/prisma/client";

const WORKFLOW_STATUS_LABELS: Record<PaymentWorkflowStatus, string> = {
  PENDING: "Pending",
  AUTHORIZED: "Authorized",
  FAILED: "Failed",
  CONFIRMED: "Confirmed",
  CANCELLED: "Cancelled",
};

const VAULT_LABELS: Record<PaymentVaultStatus, { label: string; detail: string }> = {
  VAULTED: { label: "Vaulted", detail: "Saved securely with the payment provider — it can be charged from this page." },
  NOT_VAULTED: { label: "Legacy record", detail: "Recorded before the payment provider was connected. There is nothing to charge from the CRM." },
  DETACHED: { label: "Removed at provider", detail: "This card was removed at the payment provider and can no longer be charged." },
};

type PaymentMethodSummary = {
  id: string;
  cardholderName: string;
  last4: string;
  cardBrand: string | null;
  expiryMonth: number;
  expiryYear: number;
  amountAllocated: number;
  workflowStatus: PaymentWorkflowStatus;
  status: PaymentMethodStatus;
  vaultStatus: PaymentVaultStatus;
};

function isExpired(month: number, year: number, now = new Date()): boolean {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return year < y || (year === y && month < m);
}

/**
 * The safe view of one saved payment method on a booking: brand, last four,
 * expiry, cardholder, amount allocated, and whether the payment provider holds
 * a chargeable credential for it. There is no way to see a full card number or
 * a security code from here — Compass Tools has neither. Charging is done in the
 * panel below this card (Admin only).
 */
export function PaymentMethodCard({
  bookingId,
  label,
  paymentMethod,
  canManageStatus,
  currency,
}: {
  bookingId: string;
  label: string;
  paymentMethod: PaymentMethodSummary;
  canManageStatus: boolean;
  /** The booking's actual transaction currency — never assume USD for a
   * customer payment amount (see lib/currency.ts's formatMoney). */
  currency: SupportedCurrency;
}) {
  function setWorkflowStatus(next: PaymentWorkflowStatus) {
    updatePaymentMethodWorkflowStatus({ paymentMethodId: paymentMethod.id, bookingId, workflowStatus: next })
      .then(() => toast.success("Status updated"))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to update status"));
  }

  const vault = VAULT_LABELS[paymentMethod.vaultStatus];
  const expired = isExpired(paymentMethod.expiryMonth, paymentMethod.expiryYear);

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
        {canManageStatus ? (
          <Select value={paymentMethod.workflowStatus} onValueChange={(v) => setWorkflowStatus(v as PaymentWorkflowStatus)}>
            <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(WORKFLOW_STATUS_LABELS).map(([value, text]) => (
                <SelectItem key={value} value={value}>{text}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">{WORKFLOW_STATUS_LABELS[paymentMethod.workflowStatus]}</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">Card</p>
          <p className="text-sm font-medium flex items-center gap-1.5">
            <CardBrandLogo brand={cardBrandFromProvider(paymentMethod.cardBrand)} />
            •••• {paymentMethod.last4}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Expires</p>
          <p className={`text-sm font-medium ${expired ? "text-destructive" : ""}`}>
            {String(paymentMethod.expiryMonth).padStart(2, "0")}/{paymentMethod.expiryYear}
            {expired ? " (expired)" : ""}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Cardholder</p>
          <p className="text-sm font-medium break-words">{paymentMethod.cardholderName}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Allocated</p>
          <p className="text-sm font-medium">{formatMoney(paymentMethod.amountAllocated, currency)}</p>
        </div>
      </div>

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        {paymentMethod.vaultStatus === "VAULTED" ? <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />}
        <span>
          <span className="font-medium text-foreground">{vault.label}.</span> {vault.detail} The card number and security code are held only by the payment provider.
        </span>
      </p>
    </div>
  );
}
