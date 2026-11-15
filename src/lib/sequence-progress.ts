// What happened to each step of one enrollment, derived ONLY from the stored facts (the enrollment's status / current step / next time, and the per-step send
// log) - never inferred from "an attempt was made". A step counts as sent only when a SENT log exists for it.
//
//   sent       - a SENT log exists for the step.
//   scheduled  - it is the step the enrollment is waiting to send (ACTIVE, sequence on), with its planned time.
//   paused     - same step, but the sequence is switched off, so nothing is being sent until it is switched back on.
//   failed     - the enrollment FAILED at this step, or the step's last attempt failed and a retry is pending (retrying).
//   cancelled  - the lead was unenrolled (or unsubscribed) before this step went out.
//   pending    - a later step of an ACTIVE enrollment: waits for the steps before it.
//
//   sending    - a send for this step is in progress right now (its in-flight marker is recent).
//   uncertain  - a send was started but Gmail never confirmed it, so it is NOT known whether the email went out; it is not resent until a person decides.
//
// "Skipped" is deliberately absent: this model has no way to skip a step (a failed step is retried, then ends the enrollment), so reporting one would be invented.

import { isRealFailure, openDelivery, isRecentInFlight } from "@/lib/sequence-delivery";
import type { StatusTone } from "@/lib/status-meta";

export type StepProgressStatus = "sent" | "scheduled" | "paused" | "failed" | "cancelled" | "pending" | "sending" | "uncertain";

export type StepProgress = {
  stepId: string;
  /** 1-based position in the sequence. */
  position: number;
  status: StepProgressStatus;
  /** When the SENT log was written (sent) or when the step is planned to go out (scheduled). */
  at: Date | null;
  /** A failed attempt exists for this step and the enrollment is still trying (status "failed" with retrying = true), or the enrollment gave up (retrying = false). */
  retrying?: boolean;
};

type StepLike = { id: string };
type LogLike = { stepId: string; status: "SENT" | "FAILED"; sentAt?: Date | null; createdAt?: Date | null; error?: string | null };
type EnrollmentLike = { status: "ACTIVE" | "COMPLETED" | "UNSUBSCRIBED" | "FAILED"; currentStepIdx: number; nextSendAt: Date | null };

export function computeStepProgress(params: { steps: StepLike[]; enrollment: EnrollmentLike; logs: LogLike[]; sequenceActive?: boolean; now?: number }): StepProgress[] {
  const { steps, enrollment, logs } = params;
  const now = params.now ?? Date.now();
  const active = params.sequenceActive !== false;
  const sentAtByStep = new Map<string, Date | null>();
  const failedSteps = new Set<string>();
  for (const l of logs) {
    if (l.status === "SENT") {
      const at = l.sentAt ?? l.createdAt ?? null;
      const prev = sentAtByStep.get(l.stepId);
      if (!sentAtByStep.has(l.stepId) || (at && (!prev || at > prev))) sentAtByStep.set(l.stepId, at);
    } else if (isRealFailure(l)) failedSteps.add(l.stepId); // bookkeeping rows (in-flight / unconfirmed / restart markers) are not failed attempts
  }

  return steps.map((step, i) => {
    const base = { stepId: step.id, position: i + 1 };
    if (sentAtByStep.has(step.id)) return { ...base, status: "sent" as const, at: sentAtByStep.get(step.id) ?? null };
    // The enrollment only ever advances past a step after that step was sent successfully, so a step before the current one went out even if its log is gone.
    if (i < enrollment.currentStepIdx) return { ...base, status: "sent" as const, at: null };

    switch (enrollment.status) {
      case "COMPLETED":
        return { ...base, status: "pending" as const, at: null };
      case "UNSUBSCRIBED":
        return { ...base, status: "cancelled" as const, at: null };
      case "FAILED":
        return i === enrollment.currentStepIdx
          ? { ...base, status: "failed" as const, at: null, retrying: false }
          : i > enrollment.currentStepIdx
            ? { ...base, status: "cancelled" as const, at: null }
            : { ...base, status: "pending" as const, at: null };
      case "ACTIVE":
      default:
        if (i === enrollment.currentStepIdx) {
          const open = openDelivery(logs.filter((l) => l.stepId === step.id));
          if (open) return isRecentInFlight(open.log, now) ? { ...base, status: "sending" as const, at: null } : { ...base, status: "uncertain" as const, at: null };
          if (failedSteps.has(step.id)) return { ...base, status: "failed" as const, at: enrollment.nextSendAt, retrying: true };
          return { ...base, status: active ? ("scheduled" as const) : ("paused" as const), at: enrollment.nextSendAt };
        }
        return { ...base, status: "pending" as const, at: null };
    }
  });
}

export const STEP_PROGRESS_LABEL: Record<StepProgressStatus, string> = {
  sending: "Sending",
  uncertain: "Unconfirmed",
  sent: "Sent",
  scheduled: "Scheduled",
  paused: "Paused",
  failed: "Failed",
  cancelled: "Cancelled",
  pending: "Pending",
};

// ─────────────────────────────────────────────────────────────────────────
// ONE answer to "what is this enrollment doing?", used by the lead page AND the sequence page so they can never disagree.
// ─────────────────────────────────────────────────────────────────────────

export type EnrollmentStateKey =
  | "first_email_pending" // active; step 1 has not gone out yet (waiting for its delay, or about to be sent)
  | "sending" // a send is in progress right now
  | "active" // progressing: at least one step has gone out, the next is scheduled
  | "retry_scheduled" // the last attempt at the current step failed for a temporary reason; a retry is scheduled
  | "unconfirmed" // a send was started and Gmail never confirmed it; waiting for a person (never resent automatically)
  | "paused" // active enrollment of a sequence that is switched off: nothing is being sent
  | "failed" // gave up (Gmail not usable, no email/agent, retries exhausted)
  | "unenrolled"
  | "completed";

export type EnrollmentState = { key: EnrollmentStateKey; label: string; tone: StatusTone; progressing: boolean };

const STATE_META: Record<EnrollmentStateKey, { label: string; tone: StatusTone; progressing: boolean }> = {
  first_email_pending: { label: "First email pending", tone: "info", progressing: true },
  sending: { label: "Sending", tone: "info", progressing: true },
  active: { label: "Active", tone: "info", progressing: true },
  retry_scheduled: { label: "Retry scheduled", tone: "warning", progressing: true },
  unconfirmed: { label: "Delivery unconfirmed", tone: "warning", progressing: false },
  paused: { label: "Paused", tone: "warning", progressing: false },
  failed: { label: "Failed", tone: "destructive", progressing: false },
  unenrolled: { label: "Unenrolled", tone: "neutral", progressing: false },
  completed: { label: "Completed", tone: "success", progressing: false },
};

export function deriveEnrollmentState(params: {
  enrollment: EnrollmentLike;
  steps: StepLike[];
  logs: LogLike[];
  sequenceActive?: boolean;
  now?: number;
}): EnrollmentState {
  const { enrollment, steps, logs } = params;
  const pick = (key: EnrollmentStateKey): EnrollmentState => ({ key, ...STATE_META[key] });
  if (enrollment.status === "UNSUBSCRIBED") return pick("unenrolled");
  if (enrollment.status === "COMPLETED") return pick("completed");
  if (enrollment.status === "FAILED") return pick("failed");

  const currentId = steps[enrollment.currentStepIdx]?.id;
  const currentLogs = logs.filter((l) => l.stepId === currentId);
  const open = openDelivery(currentLogs);
  if (open) return isRecentInFlight(open.log, params.now) ? pick("sending") : pick("unconfirmed");
  if (params.sequenceActive === false) return pick("paused");
  if (currentLogs.some(isRealFailure)) return pick("retry_scheduled");
  const anySent = enrollment.currentStepIdx > 0 || logs.some((l) => l.status === "SENT");
  return anySent ? pick("active") : pick("first_email_pending");
}
