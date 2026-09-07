"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2, ShieldAlert, KeyRound, X, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CardBrandLogo } from "@/components/ui/card-brand-logo";
import { revealPaymentMethod, updatePaymentMethodWorkflowStatus } from "@/server/actions/payment-methods";
import { startSupplierPaymentAuthorization, endSupplierPaymentAuthorization } from "@/server/security/cvv-authorization";
import { requestCvvRecollection } from "@/server/actions/cvv-recollection";
import { formatMoney, type SupportedCurrency } from "@/lib/currency";
import type { CardBrand } from "@/lib/card-validation";
import type { PaymentMethodStatus, PaymentWorkflowStatus } from "@/generated/prisma/client";

const REVEAL_TIMEOUT_SECONDS = 60;
const AUTHORIZATION_TIMEOUT_SECONDS = 60;

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

type SupplierAuthorization = {
  amountAllocated: number | null;
  cvv: string | null;
  cvvAvailable: boolean;
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
 * Two independent, permission-gated privileged views on the same card:
 *   - Reveal: masked-by-default, 60s auto-hide, shows the legitimately
 *     retained PAN/cardholder/expiration/brand. Never involves a CVV.
 *   - Start Supplier Payment: a separate, more sensitive workflow gated by
 *     its own permission (canAuthorizeSupplierPayment). Each click is a
 *     fresh server-side authorization — see cvv-authorization.ts — that
 *     surfaces the customer's originally submitted CVV only while its
 *     short-lived window is still open. Once that window has elapsed (or a
 *     prior authorization already consumed/ended it), the server returns
 *     cvvAvailable: false and the UI shows "CVV — Not retained — new
 *     authorization required" rather than any recoverable historical value.
 * Both panels hold their revealed data only in this component's own local
 * state, auto-hide after a short timeout, and are cleared on unmount.
 */
export function PaymentMethodCard({
  bookingId,
  label,
  paymentMethod,
  canReveal,
  canAuthorizeSupplierPayment,
  canManageStatus,
  currency,
}: {
  bookingId: string;
  label: string;
  paymentMethod: PaymentMethodSummary;
  canReveal: boolean;
  canAuthorizeSupplierPayment: boolean;
  canManageStatus: boolean;
  /** The booking's actual transaction currency — never assume USD for a
   * customer payment amount (see lib/currency.ts's formatMoney). */
  currency: SupportedCurrency;
}) {
  const [revealed, setRevealed] = useState<RevealedCard | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_TIMEOUT_SECONDS);
  const [isPending, setIsPending] = useState(false);
  // Two independent timers, deliberately not one: `revealTickRef` only ever
  // decrements the displayed countdown (a plain functional setState update,
  // nothing else). `revealExpiryRef` is a single one-shot setTimeout,
  // scheduled once when Reveal is clicked, whose callback is the ONLY place
  // that ever calls hide(). Nothing calls hide() from inside
  // setSecondsLeft's updater — see the note above cancelAuthorization below
  // for why that distinction is exactly what fixes the reported bug.
  const revealTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const revealExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [authorization, setAuthorization] = useState<SupplierAuthorization | null>(null);
  const [authSecondsLeft, setAuthSecondsLeft] = useState(AUTHORIZATION_TIMEOUT_SECONDS);
  const [authPending, setAuthPending] = useState(false);
  const [cvvVisible, setCvvVisible] = useState(false);
  const authTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const authExpiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearRevealTimers() {
    if (revealTickRef.current) {
      clearInterval(revealTickRef.current);
      revealTickRef.current = null;
    }
    if (revealExpiryRef.current) {
      clearTimeout(revealExpiryRef.current);
      revealExpiryRef.current = null;
    }
  }

  function hide() {
    clearRevealTimers();
    setRevealed(null);
  }

  function clearAuthTimers() {
    if (authTickRef.current) {
      clearInterval(authTickRef.current);
      authTickRef.current = null;
    }
    if (authExpiryRef.current) {
      clearTimeout(authExpiryRef.current);
      authExpiryRef.current = null;
    }
  }

  function endAuthorizationLocal() {
    clearAuthTimers();
    setAuthorization(null);
    setCvvVisible(false);
  }

  // The ONLY place that calls endAuthorizationLocal()/hide() as a genuine
  // side effect is: this function (invoked from the Cancel button's onClick,
  // or from authExpiryRef's one-shot timeout below), the unmount cleanup
  // effect, or the Hide button's onClick. None of them are ever called from
  // inside a setState functional updater. THAT nesting — calling
  // cancelAuthorization()/hide() (which call setState, and in
  // cancelAuthorization's case also an async server action) directly inside
  // setAuthSecondsLeft's/setSecondsLeft's updater callback — is exactly what
  // produced the reported "Cannot update a component (Router) while
  // rendering a different component (PaymentMethodCard)" error: React can
  // invoke an updater function during its render phase, and triggering an
  // unrelated state update (let alone a server action / router-adjacent
  // effect) from inside one is never a valid render-phase side effect.
  async function cancelAuthorization() {
    endAuthorizationLocal();
    try {
      await endSupplierPaymentAuthorization(paymentMethod.id);
    } catch {
      // Best-effort — local state is already cleared regardless.
    }
  }

  useEffect(
    () => () => {
      clearRevealTimers();
      // Fire-and-forget: destroy any still-open server-side authorization if
      // this card unmounts (e.g. navigating away) while one is active. This
      // runs in an effect cleanup — a valid place for a side effect — not
      // during render.
      if (authTickRef.current || authExpiryRef.current) {
        clearAuthTimers();
        endSupplierPaymentAuthorization(paymentMethod.id).catch(() => {});
      }
    },
    [paymentMethod.id]
  );

  async function reveal() {
    setIsPending(true);
    try {
      const result = await revealPaymentMethod(paymentMethod.id);
      setRevealed(result);
      setSecondsLeft(REVEAL_TIMEOUT_SECONDS);
      clearRevealTimers();
      revealTickRef.current = setInterval(() => {
        setSecondsLeft((s) => Math.max(0, s - 1));
      }, 1000);
      revealExpiryRef.current = setTimeout(hide, REVEAL_TIMEOUT_SECONDS * 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to reveal payment method");
    } finally {
      setIsPending(false);
    }
  }

  async function startAuthorization() {
    setAuthPending(true);
    try {
      const result = await startSupplierPaymentAuthorization(paymentMethod.id);
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      setAuthorization({ amountAllocated: result.amountAllocated, cvv: result.cvv, cvvAvailable: result.cvvAvailable });
      setCvvVisible(false);
      setAuthSecondsLeft(AUTHORIZATION_TIMEOUT_SECONDS);
      clearAuthTimers();
      authTickRef.current = setInterval(() => {
        setAuthSecondsLeft((s) => Math.max(0, s - 1));
      }, 1000);
      authExpiryRef.current = setTimeout(() => {
        cancelAuthorization();
      }, AUTHORIZATION_TIMEOUT_SECONDS * 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to start supplier payment authorization");
    } finally {
      setAuthPending(false);
    }
  }

  const [recollectionPending, setRecollectionPending] = useState(false);
  const [recollectionRequested, setRecollectionRequested] = useState(false);

  // CVV recollection follow-up — the PCI-compliant alternative to
  // extending the underlying cache's TTL (see cvv-cache.ts's own header):
  // when the originally-cached CVV is no longer retained, this asks the
  // CUSTOMER to confirm it again via a short-lived emailed link, rather
  // than the agent sourcing/retaining one any other way. Local
  // `recollectionRequested` is a one-shot per-render UI acknowledgment
  // only — it does not track server state, so navigating away and back
  // correctly shows the button again (the email itself, not this flag, is
  // the durable side effect).
  async function requestCvv() {
    setRecollectionPending(true);
    try {
      const result = await requestCvvRecollection(paymentMethod.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setRecollectionRequested(true);
      toast.success("A confirmation link was emailed to the customer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to request CVV confirmation");
    } finally {
      setRecollectionPending(false);
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
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-3 space-y-3">
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

      {canAuthorizeSupplierPayment && (
        <div className="pt-2 border-t">
          {authorization ? (
            <div className="rounded-md border border-blue-300 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 px-3 py-3 space-y-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-400">
                <KeyRound className="h-3.5 w-3.5" />
                Supplier Payment Authorization — expires in {authSecondsLeft}s
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Card" value={`${paymentMethod.cardBrand ?? "Card"} •••• ${paymentMethod.last4}`} />
                <Field label="Amount" value={authorization.amountAllocated !== null ? formatMoney(authorization.amountAllocated, currency) : "Not tied to a specific booking"} />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">CVV for this authorization</p>
                {authorization.cvvAvailable && authorization.cvv ? (
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sm font-medium tracking-widest">
                      {cvvVisible ? authorization.cvv : "•".repeat(authorization.cvv.length)}
                    </span>
                    <Button size="icon-sm" variant="ghost" type="button" onClick={() => setCvvVisible((v) => !v)} aria-label={cvvVisible ? "Hide CVV" : "Show CVV"}>
                      {cvvVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground italic">CVV — Not retained — new authorization required</p>
                    {recollectionRequested ? (
                      <p className="flex items-center gap-1.5 text-xs text-success">
                        <Mail className="h-3 w-3" /> Confirmation link emailed — check back once the customer submits it
                      </p>
                    ) : (
                      <Button size="sm" variant="outline" onClick={requestCvv} disabled={recollectionPending} className="gap-1.5">
                        {recollectionPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
                        Request CVV from Customer
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <Button size="sm" variant="outline" onClick={cancelAuthorization} className="gap-1.5">
                <X className="h-3.5 w-3.5" /> Cancel Authorization
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={startAuthorization} disabled={authPending} className="gap-1.5">
              {authPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
              Start Supplier Payment
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
