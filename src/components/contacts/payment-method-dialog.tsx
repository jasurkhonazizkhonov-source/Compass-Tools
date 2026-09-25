"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { formatCardNumber, detectCardBrand, digitsOnly, isValidCardNumber, isValidExpiry } from "@/lib/card-validation";
import { addContactPaymentMethod, editPaymentMethod } from "@/server/actions/contact-payment-methods";
import { Plus, Loader2 } from "lucide-react";

type FormState = {
  cardholderName: string;
  cardNumber: string;
  expiryMonth: string;
  expiryYear: string;
};

const EMPTY: FormState = { cardholderName: "", cardNumber: "", expiryMonth: "", expiryYear: "" };

/**
 * Shared add/edit dialog for a Contact-level payment method. Deliberately
 * has no CVV field at all — see addContactPaymentMethod's doc comment for
 * why a card entered here (no signed-booking-form provenance) has no
 * legitimate channel to even transiently hold one. Editing never displays
 * or requests the existing PAN — replacing it requires the full number to
 * be typed in fresh, behind an explicit "Replace card number" toggle so the
 * common case (just fixing the name or expiry) doesn't force re-entry.
 */
export function PaymentMethodDialog({
  contactId,
  mode,
  existing,
  trigger,
}: {
  contactId: string;
  mode: "add" | "edit";
  existing?: { id: string; cardholderName: string; last4: string; cardBrand: string | null; expiryMonth: number; expiryYear: number };
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(
    existing
      ? { cardholderName: existing.cardholderName, cardNumber: "", expiryMonth: String(existing.expiryMonth).padStart(2, "0"), expiryYear: String(existing.expiryYear) }
      : EMPTY
  );
  const [replacingCard, setReplacingCard] = useState(mode === "add");
  const [isPending, startTransition] = useTransition();

  const brand = detectCardBrand(form.cardNumber);

  function reset() {
    setForm(
      existing
        ? { cardholderName: existing.cardholderName, cardNumber: "", expiryMonth: String(existing.expiryMonth).padStart(2, "0"), expiryYear: String(existing.expiryYear) }
        : EMPTY
    );
    setReplacingCard(mode === "add");
  }

  function submit() {
    const expiryMonth = Number(form.expiryMonth);
    const expiryYear = Number(form.expiryYear);
    if (!form.cardholderName.trim()) {
      toast.error("Cardholder name is required");
      return;
    }
    if (!isValidExpiry(expiryMonth, expiryYear)) {
      toast.error("Enter a valid, non-expired expiration date");
      return;
    }
    if (replacingCard) {
      const digits = digitsOnly(form.cardNumber);
      if (!isValidCardNumber(digits)) {
        toast.error("Enter a valid card number");
        return;
      }
    }

    startTransition(async () => {
      try {
        if (mode === "add") {
          await addContactPaymentMethod({ contactId, cardholderName: form.cardholderName, cardNumber: form.cardNumber, expiryMonth, expiryYear });
          toast.success("Payment method added");
        } else if (existing) {
          await editPaymentMethod({
            paymentMethodId: existing.id,
            cardholderName: form.cardholderName,
            expiryMonth,
            expiryYear,
            cardNumber: replacingCard ? form.cardNumber : undefined,
          });
          toast.success("Payment method updated");
        }
        setOpen(false);
        reset();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Unable to save payment method");
      }
    });
  }

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
            <Input value={form.cardholderName} onChange={(e) => setForm({ ...form, cardholderName: e.target.value })} placeholder="John Example" autoComplete="cc-name" />
          </div>

          {mode === "edit" && existing && !replacingCard ? (
            <div className="space-y-1.5">
              <Label>Card Number</Label>
              <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <CardBrandLogo brand={(existing.cardBrand as never) || "Unknown"} />
                •••• •••• •••• {existing.last4}
              </div>
              <button type="button" onClick={() => setReplacingCard(true)} className="text-xs text-primary hover:underline">
                Replace card number
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Card Number</Label>
              <div className="relative">
                <Input
                  value={form.cardNumber}
                  onChange={(e) => setForm({ ...form, cardNumber: formatCardNumber(e.target.value) })}
                  placeholder="4111 1111 1111 1111"
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
          )}

          <div className="space-y-1.5">
            <Label>Expiration</Label>
            <div className="flex items-center gap-1.5">
              <Input
                value={form.expiryMonth}
                onChange={(e) => setForm({ ...form, expiryMonth: digitsOnly(e.target.value).slice(0, 2) })}
                placeholder="MM"
                inputMode="numeric"
                autoComplete="cc-exp-month"
                maxLength={2}
                className="w-16 text-center"
              />
              <span className="text-muted-foreground">/</span>
              <Input
                value={form.expiryYear}
                onChange={(e) => setForm({ ...form, expiryYear: digitsOnly(e.target.value).slice(0, 4) })}
                placeholder="YYYY"
                inputMode="numeric"
                autoComplete="cc-exp-year"
                maxLength={4}
                className="w-20 text-center"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>Cancel</Button>
          <Button onClick={submit} disabled={isPending} className="gap-1.5">
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {mode === "add" ? "Add Card" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
