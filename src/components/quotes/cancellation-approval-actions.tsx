"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, X, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { safeActionMessage } from "@/lib/safe-action-message";
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
 *
 * Every one of these changes the quote's state or emails the customer, so each asks first in the CRM's own confirmation dialog
 * (which also provides the pending state and double-click protection) — nothing fires on the first click.
 */
type Pending = "approve" | "disregard" | "send-form" | "resend";

const COPY: Record<Pending, { title: string; description: string; confirmLabel: string; destructive: boolean; success: string; failure: string }> = {
  approve: {
    title: "Approve this cancellation?",
    description: "The cancellation is approved, but the customer is not notified yet — use Send Cancellation Form for that.",
    confirmLabel: "Approve cancellation",
    destructive: false,
    success: "Cancellation approved — the flight has not been cancelled yet. Use Send Cancellation Form to notify the customer.",
    failure: "Could not approve the cancellation",
  },
  disregard: {
    title: "Disregard this cancellation request?",
    description: "The request is closed without cancelling anything and the quote returns to Charged.",
    confirmLabel: "Disregard request",
    destructive: true,
    success: "Cancellation disregarded — quote returned to Charged",
    failure: "Could not disregard the cancellation",
  },
  "send-form": {
    title: "Send the cancellation form to the customer?",
    description: "This emails the customer a cancellation form to review and confirm. The email cannot be recalled once it is sent.",
    confirmLabel: "Send cancellation form",
    destructive: false,
    success: "Cancellation form sent — the customer can now review and confirm",
    failure: "Could not send the cancellation form",
  },
  resend: {
    title: "Resend the cancellation form?",
    description: "The customer receives the same cancellation form email again. Nothing about the request changes.",
    confirmLabel: "Resend form",
    destructive: false,
    success: "Cancellation form resent to the customer",
    failure: "Could not resend the cancellation form",
  },
};

export function CancellationApprovalActions({
  cancellationRequestId,
  mode,
}: {
  cancellationRequestId: string;
  mode: "approve" | "send-form" | "resend";
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const router = useRouter();

  async function run(kind: Pending) {
    const copy = COPY[kind];
    try {
      if (kind === "approve") await confirmCancellation(cancellationRequestId);
      else if (kind === "disregard") await disregardCancellation(cancellationRequestId);
      else if (kind === "send-form") await sendCancellationForm(cancellationRequestId);
      else await resendCancellationForm(cancellationRequestId);
    } catch (err) {
      return { error: safeActionMessage(err, copy.failure) };
    }
    toast.success(copy.success);
    router.refresh();
  }

  const active = pending ? COPY[pending] : null;
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(o) => { if (!o) setPending(null); }}
      title={active?.title ?? ""}
      description={active?.description ?? ""}
      confirmLabel={active?.confirmLabel ?? ""}
      variant={active?.destructive ? "destructive" : "default"}
      onConfirm={() => (pending ? run(pending) : undefined)}
    />
  );

  if (mode === "send-form") {
    return (
      <>
        <Button size="sm" onClick={() => setPending("send-form")} className="gap-1.5">
          <Send className="h-3.5 w-3.5" />
          Send Cancellation Form
        </Button>
        {dialog}
      </>
    );
  }

  if (mode === "resend") {
    return (
      <>
        <Button size="sm" variant="outline" onClick={() => setPending("resend")} className="gap-1.5">
          <Send className="h-3.5 w-3.5" />
          Resend Cancellation Form
        </Button>
        {dialog}
      </>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={() => setPending("approve")} className="gap-1.5">
        <Check className="h-3.5 w-3.5" />
        Approve Cancellation
      </Button>
      <Button variant="outline" size="sm" onClick={() => setPending("disregard")} className="gap-1.5">
        <X className="h-3.5 w-3.5" /> Disregard Cancellation
      </Button>
      {dialog}
    </div>
  );
}
