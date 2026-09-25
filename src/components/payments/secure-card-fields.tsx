"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { loadStripe, type StripeFieldElement, type StripeInstance } from "@/components/payments/stripe-js";

export type SecureCardHandle = {
  /** Sends the card, entered in the provider's own fields, to the provider for vaulting. Resolves with the capture id only. */
  confirmSetup(clientSecret: string, cardholderName: string): Promise<{ ok: true; setupIntentId: string } | { ok: false; error: string }>;
  isComplete(): boolean;
};

const FIELD_STYLE = { base: { fontSize: "14px", color: "#111827", "::placeholder": { color: "#9ca3af" } }, invalid: { color: "#dc2626" } };
const FIELD_BOX = "h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-xs";

/**
 * The card number, expiry and security-code inputs. Each one is an iframe
 * served by the payment provider, so what the customer types never enters this
 * page's JavaScript, this app's server, or its database — Compass Tools only
 * ever receives an opaque reference for the vaulted card. There is deliberately
 * no React state, prop or event carrying any of those values.
 */
export const SecureCardFields = forwardRef<
  SecureCardHandle,
  { publishableKey: string; onBrandChange?: (brand: string) => void; onCompleteChange?: (complete: boolean) => void }
>(function SecureCardFields({ publishableKey, onBrandChange, onCompleteChange }, ref) {
  const numberRef = useRef<HTMLDivElement>(null);
  const expiryRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<StripeInstance | null>(null);
  const numberEl = useRef<StripeFieldElement | null>(null);
  const complete = useRef({ number: false, expiry: false, code: false });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const callbacks = useRef({ onBrandChange, onCompleteChange });
  useEffect(() => {
    callbacks.current = { onBrandChange, onCompleteChange };
  });

  useEffect(() => {
    let cancelled = false;
    const elements: StripeFieldElement[] = [];
    loadStripe(publishableKey)
      .then((stripe) => {
        if (cancelled || !numberRef.current || !expiryRef.current || !codeRef.current) return;
        stripeRef.current = stripe;
        const els = stripe.elements();
        const emit = () => callbacks.current.onCompleteChange?.(complete.current.number && complete.current.expiry && complete.current.code);
        const setup = (type: "cardNumber" | "cardExpiry" | "cardCvc", key: "number" | "expiry" | "code", target: HTMLDivElement) => {
          const el = els.create(type, { style: FIELD_STYLE, ...(type === "cardNumber" ? { showIcon: false } : {}) });
          el.on("change", (e) => {
            complete.current[key] = !!e.complete;
            setFieldError(e.error?.message ?? null);
            if (key === "number" && e.brand) callbacks.current.onBrandChange?.(e.brand);
            emit();
          });
          el.mount(target);
          elements.push(el);
          return el;
        };
        numberEl.current = setup("cardNumber", "number", numberRef.current);
        setup("cardExpiry", "expiry", expiryRef.current);
        setup("cardCvc", "code", codeRef.current);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setLoadError("We couldn't load the secure card form. Please check your connection and reload the page.");
      });
    return () => {
      cancelled = true;
      for (const el of elements) {
        try {
          el.destroy();
        } catch {
          // already torn down
        }
      }
      numberEl.current = null;
    };
  }, [publishableKey]);

  useImperativeHandle(ref, () => ({
    isComplete: () => complete.current.number && complete.current.expiry && complete.current.code,
    async confirmSetup(clientSecret, cardholderName) {
      const stripe = stripeRef.current;
      const card = numberEl.current;
      if (!stripe || !card) return { ok: false, error: "The secure card form is not ready yet. Please wait a moment and try again." };
      const result = await stripe.confirmCardSetup(clientSecret, { payment_method: { card, billing_details: { name: cardholderName } } });
      if (result.error || !result.setupIntent) {
        // The provider's message is written for the cardholder ("Your card was declined.") and never contains card data.
        return { ok: false, error: result.error?.message ?? "Your card could not be verified. Please check the details and try again." };
      }
      if (result.setupIntent.status !== "succeeded") return { ok: false, error: "Your card could not be verified. Please try again or use a different card." };
      return { ok: true, setupIntentId: result.setupIntent.id };
    },
  }));

  if (loadError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {loadError}
      </p>
    );
  }

  return (
    <div className="space-y-4" data-secure-card-fields data-ready={ready}>
      <div className="space-y-1.5">
        <Label>Card Number *</Label>
        <div ref={numberRef} className={FIELD_BOX} aria-busy={!ready} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Expiration *</Label>
          <div ref={expiryRef} className={FIELD_BOX} />
        </div>
        <div className="space-y-1.5">
          <Label>Security code *</Label>
          <div ref={codeRef} className={FIELD_BOX} />
        </div>
      </div>
      {fieldError && (
        <p role="alert" className="text-xs text-destructive">
          {fieldError}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Your card details are entered directly into our payment provider&apos;s secure form. We never see or store your card number or security code.
      </p>
    </div>
  );
});
