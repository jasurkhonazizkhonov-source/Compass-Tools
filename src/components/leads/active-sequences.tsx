import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import { StatusBadge } from "@/components/crm/status-badge";
import { UnenrollSequenceButton } from "@/components/leads/unenroll-sequence-button";
import { EnrollmentRecoveryActions } from "@/components/sequences/enrollment-recovery-actions";
import { computeStepProgress, deriveEnrollmentState } from "@/lib/sequence-progress";
import { isInFlightMarker, isRealFailure, isUncertainMarker, markerReason } from "@/lib/sequence-delivery";

export type LeadEnrollment = {
  id: string;
  status: "ACTIVE" | "COMPLETED" | "UNSUBSCRIBED" | "FAILED";
  currentStepIdx: number;
  enrolledAt: Date;
  nextSendAt: Date | null;
  completedAt: Date | null;
  sequence: { id: string; name: string; isActive?: boolean; steps: { id: string }[] };
  enrolledBy: { fullName: string } | null;
  /** The per-step send log (newest first). Optional so older callers keep working; without it the state is derived from the enrollment alone. */
  stepLogs?: { stepId: string; status: "SENT" | "FAILED"; sentAt?: Date | null; createdAt?: Date | null; error?: string | null }[];
};

/** "Step 2 of 5", never past the last step. */
export function stepLabel(e: Pick<LeadEnrollment, "currentStepIdx" | "sequence">): string {
  const total = e.sequence.steps.length;
  return `Step ${Math.min(e.currentStepIdx + 1, Math.max(total, 1))} of ${total}`;
}

const stamp = (d: Date) => format(d, "MMM d, yyyy 'at' h:mm a");

/** The one status for this enrollment - the same function the sequence page uses, so the two pages cannot disagree. */
export function enrollmentStateOf(e: LeadEnrollment) {
  return deriveEnrollmentState({ enrollment: e, steps: e.sequence.steps, logs: e.stepLogs ?? [], sequenceActive: e.sequence.isActive });
}

/** The most recent step that actually went out ("Step 2 - Nov 14 ... "), from the send log; null when nothing has been sent. */
function lastSent(e: LeadEnrollment): { position: number; at: Date | null } | null {
  const progress = computeStepProgress({ steps: e.sequence.steps, enrollment: e, logs: e.stepLogs ?? [], sequenceActive: e.sequence.isActive });
  const sent = [...progress].reverse().find((p) => p.status === "sent");
  return sent ? { position: sent.position, at: sent.at } : null;
}

/**
 * One GENUINELY active enrollment: its real status (First email pending / Sending / Active / Retry scheduled / Delivery unconfirmed / Paused), who and when,
 * the current step, the last step that actually went out, when the next one is due, what to do when something needs attention, and the Unenroll action. Only
 * ever rendered for enrollments whose status is ACTIVE - a failed, unenrolled or completed one is history, never shown here (see splitEnrollments).
 */
export function ActiveSequenceCard({ enrollment: e, leadId }: { enrollment: LeadEnrollment; leadId: string }) {
  const state = enrollmentStateOf(e);
  const sent = lastSent(e);
  const logs = e.stepLogs ?? [];
  const lastError = logs.find((l) => isRealFailure(l))?.error ?? null;
  const uncertain = state.key === "unconfirmed" ? markerReason(logs.find((l) => isUncertainMarker(l) || isInFlightMarker(l))?.error) : null;
  return (
    <li className="rounded-md border px-3 py-2.5 space-y-1.5" data-testid="active-sequence" data-state={state.key}>
      <div className="flex items-center justify-between gap-2">
        <Link href={`/sequences/${e.sequence.id}`} className="text-sm font-medium hover:underline">
          {e.sequence.name}
        </Link>
        <StatusBadge label={state.label} tone={state.tone} />
      </div>
      <p className="text-xs text-muted-foreground">
        Enrolled {stamp(e.enrolledAt)} ({formatDistanceToNow(e.enrolledAt, { addSuffix: true })}) by {e.enrolledBy?.fullName ?? "System"}
      </p>
      {e.sequence.isActive === false && (
        <p className="text-xs font-medium text-warning-foreground" data-testid="sequence-inactive-note">
          This sequence is switched off, so no further emails are being sent. They resume if it is switched back on.
        </p>
      )}
      {state.key === "retry_scheduled" && (
        <p className="text-xs text-muted-foreground" data-testid="retry-note">
          The last attempt failed{lastError ? `: ${lastError}` : ""}. {e.nextSendAt ? `It will be retried automatically at ${stamp(e.nextSendAt)}.` : "A retry is scheduled."}
        </p>
      )}
      {state.key === "unconfirmed" && (
        <p className="text-xs text-muted-foreground" data-testid="unconfirmed-note">
          Gmail did not confirm whether this email was sent{uncertain ? ` (${uncertain})` : ""}. It will <strong>not</strong> be resent automatically: check the sender&apos;s Gmail Sent folder,
          then record it as sent or send it again.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {stepLabel(e)}
          {sent ? ` · Last sent: step ${sent.position}${sent.at ? ` (${stamp(sent.at)})` : ""}` : " · Nothing sent yet"}
          {e.nextSendAt && e.sequence.isActive !== false && state.key !== "unconfirmed" && ` · Next email: ${format(e.nextSendAt, "MMM d, yyyy 'at' h:mm a")}`}
        </p>
        <UnenrollSequenceButton enrollmentId={e.id} leadId={leadId} sequenceName={e.sequence.name} />
      </div>
      <EnrollmentRecoveryActions enrollmentId={e.id} leadId={leadId} state={state.key} sequenceName={e.sequence.name} />
    </li>
  );
}

/** Only ACTIVE enrollments count as active; everything else is history. */
export function splitEnrollments(enrollments: LeadEnrollment[]) {
  return { active: enrollments.filter((e) => e.status === "ACTIVE"), history: enrollments.filter((e) => e.status !== "ACTIVE") };
}
