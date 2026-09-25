"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/crm/status-badge";
import { PAYMENT_CHARGE_STATUS_META } from "@/lib/status-meta";
import { confirmPaymentReceived } from "@/server/actions/payment-methods";
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
};

/**
 * Manual payment confirmation — replaces the old Stripe-driven automatic
 * charge. An authorized agent attests they processed the card (revealed via
 * PaymentMethodCard) with the airline/supplier directly, then records the
 * outcome here so the existing BOOKED->CHARGED quote automation still fires.
 */
export function ChargeCustomerPanel({
  bookingId,
  paymentMethodId,
  defaultAmount,
  currency,
  canConfirm,
  charges,
}: {
  bookingId: string;
  paymentMethodId: string;
  defaultAmount: number;
  /** The booking's actual transaction currency — the new-charge amount
   * entered here is denominated in this, never assumed to be USD. */
  currency: SupportedCurrency;
  canConfirm: boolean;
  charges: ChargeRow[];
}) {
  const [amount, setAmount] = useState(defaultAmount.toFixed(2));
  const [status, setStatus] = useState<"SUCCEEDED" | "FAILED">("SUCCEEDED");
  const [referenceNote, setReferenceNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    startTransition(async () => {
      try {
        const result = await confirmPaymentReceived({
          bookingId,
          paymentMethodId,
          amount: parsedAmount,
          status,
          referenceNote: referenceNote || undefined,
        });
        toast.success(result.status === "SUCCEEDED" ? "Payment confirmed" : "Payment recorded as failed");
        setAmount(defaultAmount.toFixed(2));
        setReferenceNote("");
        setStatus("SUCCEEDED");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Unable to record payment");
      }
    });
  }

  return (
    <div className="space-y-4">
      {canConfirm && (
        <div className="space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-end gap-2">
            <div className="space-y-1.5 w-full sm:flex-1 sm:min-w-0">
              <Label className="text-xs">Amount ({currency})</Label>
              <Input type="number" min={0.01} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1.5 w-full sm:w-40">
              <Label className="text-xs">Outcome</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as "SUCCEEDED" | "FAILED")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="SUCCEEDED">Succeeded</SelectItem>
                  <SelectItem value="FAILED">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={submit} disabled={isPending} className="gap-1.5 w-full sm:w-auto">
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              Record Payment
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Reference Note (optional)</Label>
            <Textarea value={referenceNote} onChange={(e) => setReferenceNote(e.target.value)} placeholder="e.g. Charged via airline direct billing, confirmation #12345" rows={2} />
          </div>
        </div>
      )}

      {charges.length > 0 ? (
        <div className="space-y-2">
          {charges.map((c) => {
            const meta = PAYMENT_CHARGE_STATUS_META[c.status];
            return (
              <div key={c.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <div>
                  <p className="font-medium">{formatMoney(Number(c.amount), isSupportedCurrency(c.currency.toUpperCase()) ? (c.currency.toUpperCase() as SupportedCurrency) : currency)}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.referenceNote ?? "Manual payment confirmation"} · {c.initiatedBy?.fullName ?? "System"} · {formatDistanceToNow(c.createdAt, { addSuffix: true })}
                  </p>
                  {c.errorMessage && <p className="text-xs text-destructive mt-0.5">{c.errorMessage}</p>}
                </div>
                <StatusBadge label={meta.label} tone={meta.tone} />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No charges yet.</p>
      )}
    </div>
  );
}
