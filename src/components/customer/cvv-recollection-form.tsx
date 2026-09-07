"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { submitRecollectedCvv } from "@/server/actions/cvv-recollection";
import { CloseBookingButton } from "@/components/customer/close-booking-button";

/**
 * The customer's own confirmation step — collects ONLY the CVV (never the
 * full card number again) and submits it once. On success, the server has
 * already cached it via the exact same mechanism every other CVV in this
 * app uses (a short authorization window, single-use per authorization,
 * never persisted to a database) — this component's job ends at showing a
 * clear confirmation, nothing more.
 */
export function CvvRecollectionForm({ token, cardBrand, last4 }: { token: string; cardBrand: string | null; last4: string }) {
  const [cvv, setCvv] = useState("");
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit() {
    if (!cvv.trim()) {
      toast.error("Enter your card's security code first");
      return;
    }
    startTransition(async () => {
      const result = await submitRecollectedCvv(token, cvv);
      if (!result.ok) {
        toast.error(result.error);
        setCvv("");
        return;
      }
      setDone(true);
    });
  }

  if (done) {
    return (
      <div className="rounded-xl border bg-background p-8 text-center space-y-3">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/15 text-success">
          <CheckCircle2 className="h-7 w-7" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">Thanks — you&apos;re all set</h1>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          Your security code has been confirmed. Your agent will finish processing your payment shortly.
        </p>
        <div className="pt-1 flex justify-center">
          <CloseBookingButton />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-background p-8 space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-foreground">Confirm your card&apos;s security code</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {cardBrand ?? "Card"} •••• {last4}
        </p>
      </div>
      <div className="space-y-1.5 max-w-[160px]">
        <Label htmlFor="cvv-recollection-input">Security Code (CVV)</Label>
        <Input
          id="cvv-recollection-input"
          value={cvv}
          onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
          inputMode="numeric"
          autoComplete="cc-csc"
          maxLength={4}
          placeholder="123"
          className="text-center tracking-widest text-lg"
          autoFocus
        />
      </div>
      <Button onClick={submit} disabled={isPending} className="w-full gap-2">
        {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Confirm Security Code
      </Button>
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground justify-center">
        <ShieldCheck className="h-3 w-3" /> Secure, one-time link — please don&apos;t forward this page
      </p>
    </div>
  );
}
