"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { revealPaymentMethod, updatePaymentMethodWorkflowStatus } from "@/server/actions/payment-methods";
import { formatMoney, type SupportedCurrency } from "@/lib/currency";
import { safeActionMessage } from "@/lib/safe-action-message";
import { useTimedReveal } from "./use-timed-reveal";
import type { CardBrand } from "@/lib/card-validation";
import type { PaymentMethodStatus, PaymentWorkflowStatus } from "@/generated/prisma/client";

const WORKFLOW_STATUS_LABELS: Record<PaymentWorkflowStatus, string> = {
  PENDING: "Pending",
  AUTHORIZED: "Authorized",
  FAILED: "Failed",
  CONFIRMED: "Confirmed",
  CANCELLED: "Cancelled",
};

type RevealedCard = {
  cardholderName: string;
  pan: string;
  cardBrand: string | null;
  expiryMonth: number;
  expiryYear: number;
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
};

/**
 * A permission-gated privileged view on the card: Reveal is masked by
 * default, auto-hides after 30s — and immediately when the tab
 * is hidden, the window loses focus or the component unmounts — and shows the
 * retained PAN/cardholder/expiration/brand. The number is not selectable and
 * copy/cut are blocked, so it is never put on the clipboard by default (staff
 * read it and key it into the supplier's system by hand). There is no security code (CVV/CVC)
 * anywhere in this app: it is never collected, cached or displayed. The
 * revealed data lives only in this component's local state and is cleared
 * on unmount.
 */
export function PaymentMethodCard({
  bookingId,
  label,
  paymentMethod,
  canReveal,
  canManageStatus,
  currency,
}: {
  bookingId: string;
  label: string;
  paymentMethod: PaymentMethodSummary;
  canReveal: boolean;
  canManageStatus: boolean;
  /** The booking's actual transaction currency — never assume USD for a
   * customer payment amount (see lib/currency.ts's formatMoney). */
  currency: SupportedCurrency;
}) {
  const { value: revealed, secondsLeft, show, hide } = useTimedReveal<RevealedCard>();
  const [isPending, setIsPending] = useState(false);

  async function reveal() {
    setIsPending(true);
    try {
      const result = await revealPaymentMethod(paymentMethod.id);
      if ("error" in result) {
        toast.error(result.error, { duration: 8000 });
        return;
      }
      show(result);
    } catch (err) {
      toast.error(safeActionMessage(err, "Unable to reveal this card. You may not have permission."));
    } finally {
      setIsPending(false);
    }
  }

  function setWorkflowStatus(next: PaymentWorkflowStatus) {
    updatePaymentMethodWorkflowStatus({ paymentMethodId: paymentMethod.id, bookingId, workflowStatus: next })
      .then(() => toast.success("Status updated"))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Failed to update status"));
  }

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

      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Card</p>
          <p className="text-sm font-medium flex items-center gap-1.5">
            <CardBrandLogo brand={(paymentMethod.cardBrand as CardBrand) || "Unknown"} />
            •••• •••• •••• {paymentMethod.last4}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Expiration</p>
          <p className="text-sm font-medium">
            {String(paymentMethod.expiryMonth).padStart(2, "0")}/{paymentMethod.expiryYear}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Allocated</p>
          <p className="text-sm font-medium">{formatMoney(paymentMethod.amountAllocated, currency)}</p>
        </div>
      </div>

      {canReveal && (
        <div>
          {revealed ? (
            <div
              className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-3 space-y-3 select-none"
              onCopy={(e) => e.preventDefault()}
              onCut={(e) => e.preventDefault()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                <ShieldAlert className="h-3.5 w-3.5" />
                Privileged view — auto-hides in {secondsLeft}s
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cardholder Name" value={revealed.cardholderName} />
                <Field label="Card Number" value={revealed.pan.replace(/(.{4})/g, "$1 ").trim()} />
                <Field label="Expiration" value={`${String(revealed.expiryMonth).padStart(2, "0")}/${revealed.expiryYear}`} />
              </div>
              <Button size="sm" variant="outline" onClick={hide} className="gap-1.5">
                <EyeOff className="h-3.5 w-3.5" /> Hide
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={reveal} disabled={isPending} className="gap-1.5">
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
              Reveal
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium font-mono break-words">{value}</p>
    </div>
  );
}
