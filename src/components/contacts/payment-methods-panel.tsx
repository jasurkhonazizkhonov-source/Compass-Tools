"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, ShieldAlert, Pencil, Trash2, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { EmptyState } from "@/components/crm/empty-state";
import { PaymentMethodDialog } from "./payment-method-dialog";
import { revealPaymentMethod } from "@/server/actions/payment-methods";
import { removePaymentMethod } from "@/server/actions/contact-payment-methods";
import type { CardBrand } from "@/lib/card-validation";
import { safeActionMessage } from "@/lib/safe-action-message";
import { useTimedReveal } from "@/components/bookings/use-timed-reveal";
import { RevealedCardFields, type RevealedCardData } from "@/components/bookings/revealed-card-fields";

type ContactPaymentMethod = {
  id: string;
  cardholderName: string;
  last4: string;
  cardBrand: string | null;
  expiryMonth: number;
  expiryYear: number;
  bookingId: string | null;
};

/**
 * "Payment Methods" section on the Contact detail page — every card on
 * file for this customer, whether it came from a signed booking form or
 * was added directly here. Reveal/Edit/Remove are
 * all permission-gated server-side (canManageContactPaymentMethods /
 * canRevealPaymentMethod) — these buttons
 * render unconditionally and the server call itself is the real security
 * boundary, matching this app's established pattern of never relying on a
 * hidden button as the only gate.
 */
export function PaymentMethodsPanel({
  contactId,
  paymentMethods,
  canReveal,
  canManage,
}: {
  contactId: string;
  paymentMethods: ContactPaymentMethod[];
  canReveal: boolean;
  canManage: boolean;
}) {
  if (paymentMethods.length === 0 && !canManage) {
    return <EmptyState icon={CreditCard} title="No payment methods on file" description="Cards submitted through a booking form, or added directly, will appear here." />;
  }

  return (
    <div className="space-y-3">
      {paymentMethods.length === 0 ? (
        <EmptyState icon={CreditCard} title="No payment methods on file" description="Cards submitted through a booking form, or added directly, will appear here." />
      ) : (
        <div className="space-y-3">
          {paymentMethods.map((pm) => (
            <PaymentMethodRow
              key={pm.id}
              contactId={contactId}
              paymentMethod={pm}
              canReveal={canReveal}
              canManage={canManage}
            />
          ))}
        </div>
      )}
      {canManage && (
        <PaymentMethodDialog contactId={contactId} mode="add" />
      )}
    </div>
  );
}

function PaymentMethodRow({
  contactId,
  paymentMethod,
  canReveal,
  canManage,
}: {
  contactId: string;
  paymentMethod: ContactPaymentMethod;
  canReveal: boolean;
  canManage: boolean;
}) {
  const { value: revealed, secondsLeft, show, hide } = useTimedReveal<RevealedCardData>();
  const [isPending, setIsPending] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  async function reveal() {
    setIsPending(true);
    try {
      const result = await revealPaymentMethod(paymentMethod.id);
      if ("error" in result) {
        toast.error(result.error, { duration: 8000 });
        return;
      }
      show({ cardholderName: result.cardholderName, pan: result.pan, cardBrand: result.cardBrand, expiryMonth: result.expiryMonth, expiryYear: result.expiryYear });
    } catch (err) {
      toast.error(safeActionMessage(err, "Unable to reveal this card. You may not have permission."));
    } finally {
      setIsPending(false);
    }
  }

  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Runs from the confirmation dialog, which shows the pending state and stays open with the message if this fails.
  async function remove() {
    setIsRemoving(true);
    try {
      await removePaymentMethod(paymentMethod.id);
      toast.success("Payment method removed");
    } catch (err) {
      return { error: safeActionMessage(err, "Unable to remove this payment method.") };
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CardBrandLogo brand={(paymentMethod.cardBrand as CardBrand) || "Unknown"} />
          <div>
            <p className="text-sm font-medium">•••• {paymentMethod.last4}</p>
            <p className="text-xs text-muted-foreground">
              Expires {String(paymentMethod.expiryMonth).padStart(2, "0")}/{paymentMethod.expiryYear} · {paymentMethod.cardholderName}
              {paymentMethod.bookingId && " · From a booking"}
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-1">
            <PaymentMethodDialog
              contactId={contactId}
              mode="edit"
              existing={paymentMethod}
              trigger={
                <Button size="icon-sm" variant="ghost" aria-label="Edit payment method">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              }
            />
            <Button size="icon-sm" variant="ghost" onClick={() => setConfirmingRemove(true)} disabled={isRemoving} className="text-muted-foreground hover:text-destructive" aria-label="Remove payment method">
              {isRemoving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title="Remove this payment method?"
        description={`Remove ${paymentMethod.cardBrand ?? "card"} ending ${paymentMethod.last4}? Its stored card number will be permanently destroyed and can't be used for future charges.`}
        confirmLabel="Remove card"
        onConfirm={remove}
      />

      {canReveal && (
        <div>
          {revealed ? (
            <div
              className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-3 space-y-2 select-none"
              onCopy={(e) => e.preventDefault()}
              onCut={(e) => e.preventDefault()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                <ShieldAlert className="h-3.5 w-3.5" />
                Privileged view — auto-hides in {secondsLeft}s
              </div>
              <RevealedCardFields card={revealed} />
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
