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
// "Skipped" is deliberately absent: this model has no way to skip a step (a failed step is retried, then ends the enrollment), so reporting one would be invented.

export type StepProgressStatus = "sent" | "scheduled" | "paused" | "failed" | "cancelled" | "pending";

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
type LogLike = { stepId: string; status: "SENT" | "FAILED"; sentAt?: Date | null; createdAt?: Date };
type EnrollmentLike = { status: "ACTIVE" | "COMPLETED" | "UNSUBSCRIBED" | "FAILED"; currentStepIdx: number; nextSendAt: Date | null };

export function computeStepProgress(params: { steps: StepLike[]; enrollment: EnrollmentLike; logs: LogLike[]; sequenceActive?: boolean }): StepProgress[] {
  const { steps, enrollment, logs } = params;
  const active = params.sequenceActive !== false;
  const sentAtByStep = new Map<string, Date | null>();
  const failedSteps = new Set<string>();
  for (const l of logs) {
    if (l.status === "SENT") {
      const at = l.sentAt ?? l.createdAt ?? null;
      const prev = sentAtByStep.get(l.stepId);
      if (!sentAtByStep.has(l.stepId) || (at && (!prev || at > prev))) sentAtByStep.set(l.stepId, at);
    } else failedSteps.add(l.stepId);
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
          if (failedSteps.has(step.id)) return { ...base, status: "failed" as const, at: enrollment.nextSendAt, retrying: true };
          return { ...base, status: active ? ("scheduled" as const) : ("paused" as const), at: enrollment.nextSendAt };
        }
        return { ...base, status: "pending" as const, at: null };
    }
  });
}

export const STEP_PROGRESS_LABEL: Record<StepProgressStatus, string> = {
  sent: "Sent",
  scheduled: "Scheduled",
  paused: "Paused",
  failed: "Failed",
  cancelled: "Cancelled",
  pending: "Pending",
};
