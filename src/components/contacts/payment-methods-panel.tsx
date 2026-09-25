"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, ShieldAlert, Pencil, Trash2, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { EmptyState } from "@/components/crm/empty-state";
import { PaymentMethodDialog } from "./payment-method-dialog";
import { revealPaymentMethod } from "@/server/actions/payment-methods";
import { removePaymentMethod } from "@/server/actions/contact-payment-methods";
import type { CardBrand } from "@/lib/card-validation";

type ContactPaymentMethod = {
  id: string;
  cardholderName: string;
  last4: string;
  cardBrand: string | null;
  expiryMonth: number;
  expiryYear: number;
  bookingId: string | null;
};

const REVEAL_TIMEOUT_SECONDS = 60;

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
  const [revealed, setRevealed] = useState<{ cardholderName: string; pan: string; expiryMonth: number; expiryYear: number } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_TIMEOUT_SECONDS);
  const [isPending, setIsPending] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);

  async function reveal() {
    setIsPending(true);
    try {
      const result = await revealPaymentMethod(paymentMethod.id);
      setRevealed(result);
      setSecondsLeft(REVEAL_TIMEOUT_SECONDS);
      const tick = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
      setTimeout(() => {
        clearInterval(tick);
        setRevealed(null);
      }, REVEAL_TIMEOUT_SECONDS * 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to reveal payment method");
    } finally {
      setIsPending(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove ${paymentMethod.cardBrand ?? "card"} ending ${paymentMethod.last4}? This can't be used for future charges once removed.`)) return;
    setIsRemoving(true);
    try {
      await removePaymentMethod(paymentMethod.id);
      toast.success("Payment method removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to remove payment method");
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
            <Button size="icon-sm" variant="ghost" onClick={remove} disabled={isRemoving} className="text-muted-foreground hover:text-destructive" aria-label="Remove payment method">
              {isRemoving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )}
      </div>

      {canReveal && (
        <div>
          {revealed ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                <ShieldAlert className="h-3.5 w-3.5" />
                Privileged view — auto-hides in {secondsLeft}s
              </div>
              <p className="text-sm font-mono font-medium">{revealed.pan.replace(/(.{4})/g, "$1 ").trim()}</p>
              <Button size="sm" variant="outline" onClick={() => setRevealed(null)} className="gap-1.5">
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
