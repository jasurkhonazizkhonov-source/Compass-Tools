"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { SecureCardFields, type SecureCardHandle } from "@/components/payments/secure-card-fields";
import { cardBrandFromProvider } from "@/components/payments/brand";
import { createContactPaymentSetup, saveContactPaymentMethod, editPaymentMethod } from "@/server/actions/contact-payment-methods";
import { Plus, Loader2 } from "lucide-react";

/**
 * Shared add/edit dialog for a Contact-level payment method.
 *
 * ADD: the staff member types the card into the payment provider's hosted
 * fields (exactly as a customer would on the booking form). The number and
 * security code go straight to the provider and never through this app; we keep
 * only the provider's reference plus brand/last4/expiry.
 *
 * EDIT: only the cardholder name can change. The card itself lives with the
 * provider — to change a card, add a new one and remove the old one.
 */
export function PaymentMethodDialog({
  contactId,
  mode,
  existing,
  trigger,
  publishableKey,
}: {
  contactId: string;
  mode: "add" | "edit";
  existing?: { id: string; cardholderName: string; last4: string; cardBrand: string | null; expiryMonth: number; expiryYear: number };
  trigger?: React.ReactNode;
  /** The provider's PUBLISHABLE key, or null when no provider is configured (adding is then unavailable). */
  publishableKey?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(existing?.cardholderName ?? "");
  const [isPending, startTransition] = useTransition();
  const handle = useRef<SecureCardHandle | null>(null);
  // Stable per dialog session: the provider idempotency key for the capture.
  const slotKey = useRef<string>(crypto.randomUUID());

  function reset() {
    setName(existing?.cardholderName ?? "");
    slotKey.current = crypto.randomUUID();
  }

  function submit() {
    if (!name.trim()) {
      toast.error("Cardholder name is required");
      return;
    }
    startTransition(async () => {
      try {
        if (mode === "add") {
          if (!handle.current?.isComplete()) {
            toast.error("Enter the complete card details");
            return;
          }
          const setup = await createContactPaymentSetup({ contactId, slotKey: slotKey.current });
          if (!setup.ok) {
            toast.error(setup.error);
            return;
          }
          const confirmed = await handle.current.confirmSetup(setup.clientSecret, name.trim());
          if (!confirmed.ok) {
            toast.error(confirmed.error);
            return;
          }
          await saveContactPaymentMethod({ contactId, setupIntentId: confirmed.setupIntentId, cardholderName: name.trim() });
          toast.success("Payment method added");
        } else if (existing) {
          await editPaymentMethod({ paymentMethodId: existing.id, cardholderName: name.trim() });
          toast.success("Payment method updated");
        }
        setOpen(false);
        reset();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Unable to save payment method");
      }
    });
  }

  const cannotAdd = mode === "add" && !publishableKey;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add Another Credit Card
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add Payment Method" : "Edit Payment Method"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Cardholder Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="John Example" autoComplete="cc-name" />
          </div>

          {mode === "edit" && existing ? (
            <div className="space-y-1.5">
              <Label>Card</Label>
              <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <CardBrandLogo brand={cardBrandFromProvider(existing.cardBrand)} />
                •••• {existing.last4} · Expires {String(existing.expiryMonth).padStart(2, "0")}/{existing.expiryYear}
              </div>
              <p className="text-xs text-muted-foreground">The card itself is held by the payment provider and can&apos;t be edited. To change it, add a new card and remove this one.</p>
            </div>
          ) : cannotAdd ? (
            <p role="alert" className="text-sm text-destructive">No payment provider is configured, so a card can&apos;t be added right now.</p>
          ) : (
            publishableKey && <SecureCardFields ref={handle} publishableKey={publishableKey} />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>Cancel</Button>
          <Button onClick={submit} disabled={isPending || cannotAdd} className="gap-1.5">
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {mode === "add" ? "Add Card" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
