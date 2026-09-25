"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Pencil, Trash2, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { EmptyState } from "@/components/crm/empty-state";
import { PaymentMethodDialog } from "./payment-method-dialog";
import { removePaymentMethod } from "@/server/actions/contact-payment-methods";
import { cardBrandFromProvider } from "@/components/payments/brand";
import type { PaymentVaultStatus } from "@/generated/prisma/client";

type ContactPaymentMethod = {
  id: string;
  cardholderName: string;
  last4: string;
  cardBrand: string | null;
  expiryMonth: number;
  expiryYear: number;
  bookingId: string | null;
  vaultStatus: PaymentVaultStatus;
};

const VAULT_TEXT: Record<PaymentVaultStatus, string> = {
  VAULTED: "Saved with payment provider",
  NOT_VAULTED: "Legacy record — not chargeable",
  DETACHED: "Removed at provider",
};

/**
 * "Payment Methods" section on the Contact detail page — every card on file
 * for this customer, whether it came from a signed booking form or was added
 * directly here. Each is shown by brand, last four and expiry only: the card
 * number and security code live with the payment provider, so there is nothing
 * to reveal. Edit (name)/Remove are permission-gated server-side; the buttons
 * are only a convenience, the server call is the real boundary.
 */
export function PaymentMethodsPanel({
  contactId,
  paymentMethods,
  canManage,
  publishableKey,
}: {
  contactId: string;
  paymentMethods: ContactPaymentMethod[];
  canManage: boolean;
  /** The payment provider's publishable key (or null when none is configured). */
  publishableKey: string | null;
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
            <PaymentMethodRow key={pm.id} contactId={contactId} paymentMethod={pm} canManage={canManage} publishableKey={publishableKey} />
          ))}
        </div>
      )}
      {canManage && <PaymentMethodDialog contactId={contactId} mode="add" publishableKey={publishableKey} />}
    </div>
  );
}

function PaymentMethodRow({
  contactId,
  paymentMethod,
  canManage,
  publishableKey,
}: {
  contactId: string;
  paymentMethod: ContactPaymentMethod;
  canManage: boolean;
  publishableKey: string | null;
}) {
  const [isRemoving, setIsRemoving] = useState(false);

  async function remove() {
    if (!window.confirm(`Remove ${paymentMethod.cardBrand ?? "card"} ending ${paymentMethod.last4}? It will be removed at the payment provider and can't be charged afterward.`)) return;
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
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CardBrandLogo brand={cardBrandFromProvider(paymentMethod.cardBrand)} />
          <div>
            <p className="text-sm font-medium">•••• {paymentMethod.last4}</p>
            <p className="text-xs text-muted-foreground">
              Expires {String(paymentMethod.expiryMonth).padStart(2, "0")}/{paymentMethod.expiryYear} · {paymentMethod.cardholderName}
              {paymentMethod.bookingId && " · From a booking"}
            </p>
            <p className="text-xs text-muted-foreground">{VAULT_TEXT[paymentMethod.vaultStatus]}</p>
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-1">
            <PaymentMethodDialog
              contactId={contactId}
              mode="edit"
              existing={paymentMethod}
              publishableKey={publishableKey}
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
    </div>
  );
}
