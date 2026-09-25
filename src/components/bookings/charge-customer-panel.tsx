"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, CreditCard, Loader2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/crm/status-badge";
import { PAYMENT_CHARGE_STATUS_META } from "@/lib/status-meta";
import { confirmPaymentReceived } from "@/server/actions/payment-methods";
import { initiateManualCharge, refundManualCharge } from "@/server/actions/manual-charge";
import { formatMoney, isSupportedCurrency, type SupportedCurrency } from "@/lib/currency";
import type { PaymentChargeStatus } from "@/generated/prisma/client";

type ChargeRow = {
  id: string;
  amount: number;
  currency: string;
  status: PaymentChargeStatus;
  referenceNote: string | null;
  errorMessage: string | null;
  createdAt: Date;
  initiatedBy: { fullName: string } | null;
  /** Non-null = processed through the payment provider; null = a note about a payment taken outside the CRM. */
  provider: string | null;
  refundedAmount: number;
  failureCategory: string | null;
};

function newKey(): string {
  return crypto.randomUUID();
}

/**
 * Charging a saved (provider-vaulted) card, plus the charge history.
 *
 * "Manual charge" (Admin only, enforced on the server): the CRM asks the payment
 * provider to charge the vaulted card by its reference. No card number or
 * security code is involved. Each attempt carries a client-generated
 * idempotency key, kept across a "result unknown" retry and replaced only after
 * a final result, so a double click or a retry can never charge twice.
 *
 * The older "Record a payment taken outside the CRM" form stays for
 * bookkeeping when someone paid the airline/supplier directly.
 */
export function ChargeCustomerPanel({
  bookingId,
  paymentMethodId,
  cardLabel,
  defaultAmount,
  currency,
  canConfirm,
  canManualCharge,
  chargeBlockedReason,
  charges,
}: {
  bookingId: string;
  paymentMethodId: string;
  /** e.g. "Visa •••• 4242" — the only card identification ever shown. */
  cardLabel: string;
  defaultAmount: number;
  /** The booking's actual transaction currency — amounts are denominated in this, never assumed USD, and a manual charge can only be made in it. */
  currency: SupportedCurrency;
  canConfirm: boolean;
  canManualCharge: boolean;
  /** Why this card cannot be charged right now (legacy record, expired, removed…), or null when it can. */
  chargeBlockedReason: string | null;
  charges: ChargeRow[];
}) {
  const [amount, setAmount] = useState(defaultAmount.toFixed(2));
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Stable across a retry of an unknown outcome; renewed after any final result.
  const keyRef = useRef<string>(newKey());

  const [outStatus, setOutStatus] = useState<"SUCCEEDED" | "FAILED">("SUCCEEDED");
  const [outNote, setOutNote] = useState("");
  const [outAmount, setOutAmount] = useState(defaultAmount.toFixed(2));

  const parsedAmount = Number(amount);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0 && Math.abs(parsedAmount * 100 - Math.round(parsedAmount * 100)) < 1e-6;
  const reasonValid = reason.trim().length >= 3;

  function submitCharge() {
    startTransition(async () => {
      try {
        const result = await initiateManualCharge({ paymentMethodId, bookingId, amount: parsedAmount, reason: reason.trim(), idempotencyKey: keyRef.current });
        if (result.ok) {
          toast.success(result.status === "SUCCEEDED" ? (result.duplicate ? "This charge was already processed" : "Charge succeeded") : "Charge submitted — the provider is still processing it");
          keyRef.current = newKey();
          setUnknownOutcome(false);
          setDialogOpen(false);
          setConfirmed(false);
          setReason("");
          return;
        }
        if (result.code === "OUTCOME_UNKNOWN") {
          // Keep the SAME key: pressing Retry re-asks the provider and cannot charge twice.
          setUnknownOutcome(true);
          setDialogOpen(false);
          setConfirmed(false);
          toast.error(result.error, { duration: 12000 });
          return;
        }
        // A definitive failure: a fresh attempt gets a fresh key.
        keyRef.current = newKey();
        setUnknownOutcome(false);
        setDialogOpen(false);
        setConfirmed(false);
        toast.error(result.error, { duration: 10000 });
      } catch {
        // The request itself may not have completed. Same key => a retry is safe.
        setUnknownOutcome(true);
        setDialogOpen(false);
        setConfirmed(false);
        toast.error("The request was interrupted, so the result is unknown. Press Retry to check safely — it cannot charge twice.", { duration: 12000 });
      }
    });
  }

  function submitRefund(charge: ChargeRow) {
    if (!window.confirm(`Refund ${formatMoney(charge.amount - charge.refundedAmount, currency)} to the card ending ${cardLabel.slice(-4)}?`)) return;
    startTransition(async () => {
      try {
        const result = await refundManualCharge({ chargeId: charge.id, bookingId, idempotencyKey: newKey() });
        if (result.ok) toast.success(result.status === "REFUNDED" ? "Refunded in full" : "Partially refunded");
        else toast.error(result.error);
      } catch {
        toast.error("The refund request was interrupted. Check the charge status before trying again.");
      }
    });
  }

  function submitOutside() {
    const value = Number(outAmount);
    if (!value || value <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    startTransition(async () => {
      try {
        const result = await confirmPaymentReceived({ bookingId, paymentMethodId, amount: value, status: outStatus, referenceNote: outNote || undefined });
        toast.success(result.status === "SUCCEEDED" ? "Payment recorded" : "Failed attempt recorded");
        setOutNote("");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Unable to record payment");
      }
    });
  }

  return (
    <div className="space-y-4">
      {canManualCharge && (
        <div className="space-y-2 rounded-md border bg-muted/20 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Manual charge</p>
          {chargeBlockedReason ? (
            <p className="text-sm text-muted-foreground">{chargeBlockedReason}</p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
                <div className="space-y-1.5">
                  <Label className="text-xs">Amount ({currency})</Label>
                  <Input type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Reason (internal, required)</Label>
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Ticket purchase — fare + taxes" />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => setDialogOpen(true)} disabled={!amountValid || !reasonValid || isPending} className="gap-1.5">
                  <CreditCard className="h-3.5 w-3.5" /> Charge {amountValid ? formatMoney(parsedAmount, currency) : ""}
                </Button>
                {unknownOutcome && (
                  <Button variant="outline" onClick={submitCharge} disabled={isPending} className="gap-1.5">
                    {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Retry (safe — cannot charge twice)
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">Charged through the payment provider using the saved card. The card number and security code are never shown or needed.</p>
            </>
          )}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => !isPending && setDialogOpen(open)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm charge</DialogTitle>
            <DialogDescription>
              This will charge <span className="font-semibold text-foreground">{amountValid ? formatMoney(parsedAmount, currency) : ""}</span> to <span className="font-semibold text-foreground">{cardLabel}</span>. It moves real money.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
            <span>The customer authorized this charge for this booking.</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isPending}>Cancel</Button>
            <Button onClick={submitCharge} disabled={!confirmed || isPending} className="gap-1.5">
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Charge now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {charges.length > 0 ? (
        <div className="space-y-2">
          {charges.map((c) => {
            const meta = PAYMENT_CHARGE_STATUS_META[c.status];
            const rowCurrency = isSupportedCurrency(c.currency.toUpperCase()) ? (c.currency.toUpperCase() as SupportedCurrency) : currency;
            const refundable = canManualCharge && c.provider !== null && (c.status === "SUCCEEDED" || c.status === "PARTIALLY_REFUNDED");
            return (
              <div key={c.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">
                    {formatMoney(c.amount, rowCurrency)}
                    {c.refundedAmount > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">({formatMoney(c.refundedAmount, rowCurrency)} refunded)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground break-words">
                    {c.provider ? "Card charge" : "Recorded (taken outside the CRM)"} · {c.referenceNote ?? "No note"} · {c.initiatedBy?.fullName ?? "System"} · {formatDistanceToNow(c.createdAt, { addSuffix: true })}
                  </p>
                  {c.errorMessage && <p className="mt-0.5 text-xs text-destructive">{c.errorMessage}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {refundable && (
                    <Button size="sm" variant="ghost" className="gap-1 text-xs" onClick={() => submitRefund(c)} disabled={isPending}>
                      <Undo2 className="h-3 w-3" /> Refund
                    </Button>
                  )}
                  <StatusBadge label={meta.label} tone={meta.tone} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No charges yet.</p>
      )}

      {canConfirm && (
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Record a payment taken outside the CRM (bookkeeping only)</summary>
          <div className="mt-3 space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="w-full space-y-1.5 sm:min-w-0 sm:flex-1">
                <Label className="text-xs">Amount ({currency})</Label>
                <Input type="number" min={0.01} step="0.01" value={outAmount} onChange={(e) => setOutAmount(e.target.value)} />
              </div>
              <div className="w-full space-y-1.5 sm:w-40">
                <Label className="text-xs">Outcome</Label>
                <Select value={outStatus} onValueChange={(v) => setOutStatus(v as "SUCCEEDED" | "FAILED")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                    <SelectItem value="FAILED">Failed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button variant="outline" onClick={submitOutside} disabled={isPending} className="w-full sm:w-auto">Record</Button>
            </div>
            <Textarea value={outNote} onChange={(e) => setOutNote(e.target.value)} placeholder="e.g. Paid the airline directly, confirmation #12345 (no card numbers)" rows={2} />
          </div>
        </details>
      )}
    </div>
  );
}
