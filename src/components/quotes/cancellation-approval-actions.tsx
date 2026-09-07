"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, X, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmCancellation, disregardCancellation, sendCancellationForm, resendCancellationForm } from "@/server/actions/cancellation";

/**
 * Cancellation-review actions. Visibility here is a UX nicety only — every
 * server action independently re-checks its own authorization
 * (confirmCancellation/disregardCancellation stay Admin/Manager-only;
 * sendCancellationForm/resendCancellationForm additionally accept the
 * quote's own responsible agent — Pass 13 §30). Three distinct modes
 * matching the stages a cancellation request passes through (Part 7/8,
 * Pass 13 §31): "approve" (a PENDING request — Approve/Disregard,
 * approval-only, no customer email), "send-form" (an already-approved
 * request — the deliberate, separate action that actually notifies the
 * customer for the first time), and "resend" (the form was already sent
 * at least once and the customer hasn't confirmed yet — resend the exact
 * same email, no status change). Never more than one at once for the same
 * request — the parent page renders whichever applies based on the
 * quote's current status.
 */
export function CancellationApprovalActions({
  cancellationRequestId,
  mode,
}: {
  cancellationRequestId: string;
  mode: "approve" | "send-form" | "resend";
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleApprove() {
    startTransition(async () => {
      try {
        await confirmCancellation(cancellationRequestId);
        toast.success("Cancellation approved — the flight has not been cancelled yet. Use Send Cancellation Form to notify the customer.");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not approve the cancellation");
      }
    });
  }

  function handleDisregard() {
    startTransition(async () => {
      try {
        await disregardCancellation(cancellationRequestId);
        toast.success("Cancellation disregarded — quote returned to Charged");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not disregard the cancellation");
      }
    });
  }

  function handleSendForm() {
    startTransition(async () => {
      try {
        await sendCancellationForm(cancellationRequestId);
        toast.success("Cancellation form sent — the customer can now review and confirm");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not send the cancellation form");
      }
    });
  }

  function handleResend() {
    startTransition(async () => {
      try {
        await resendCancellationForm(cancellationRequestId);
        toast.success("Cancellation form resent to the customer");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not resend the cancellation form");
      }
    });
  }

  if (mode === "send-form") {
    return (
      <Button size="sm" onClick={handleSendForm} disabled={isPending} className="gap-1.5">
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        Send Cancellation Form
      </Button>
    );
  }

  if (mode === "resend") {
    return (
      <Button size="sm" variant="outline" onClick={handleResend} disabled={isPending} className="gap-1.5">
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        Resend Cancellation Form
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={handleApprove} disabled={isPending} className="gap-1.5">
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        Approve Cancellation
      </Button>
      <Button variant="outline" size="sm" onClick={handleDisregard} disabled={isPending} className="gap-1.5">
        <X className="h-3.5 w-3.5" /> Disregard Cancellation
      </Button>
    </div>
  );
}
