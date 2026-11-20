import Link from "next/link";
import { formatDistanceToNow, format } from "date-fns";
import { Mail } from "lucide-react";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { ApplySequenceDialog } from "@/components/sequences/apply-sequence-dialog";
import { ActiveSequenceCard, enrollmentStateOf, splitEnrollments, stepLabel, type LeadEnrollment } from "@/components/leads/active-sequences";
import { EnrollmentRecoveryActions } from "@/components/sequences/enrollment-recovery-actions";
import { isRealFailure } from "@/lib/sequence-delivery";
import type { RecipientOption } from "@/lib/customer-email-mask";

/** What a non-active enrollment looks like in the history list: never a "next email", always where it stopped. */
function historyDetail(e: LeadEnrollment): string {
  if (e.status === "COMPLETED") return `Completed${e.completedAt ? ` ${format(e.completedAt, "MMM d, yyyy")}` : ""}`;
  if (e.status === "FAILED") {
    const reason = (e.stepLogs ?? []).find((l) => isRealFailure(l))?.error;
    return `Stopped at ${stepLabel(e).toLowerCase()}${reason ? `: ${reason}` : ""} - no further emails will be sent unless it is retried`;
  }
  return `Unsubscribed at ${stepLabel(e).toLowerCase()} - no further emails will be sent`; // UNSUBSCRIBED: unenrolled by staff or the customer's own unsubscribe link
}

export function LeadSequencesPanel({
  leadId,
  enrollments,
  availableSequences,
  contactEmails = [],
  contactRecipients,
}: {
  leadId: string;
  enrollments: LeadEnrollment[];
  availableSequences: { id: string; name: string; description: string | null; stepCount: number; firstStepDelayMinutes?: number }[];
  /** Every email on file for this lead's contact, primary first — passed
   * through to ApplySequenceDialog's recipient picker (Part 4). */
  contactEmails?: string[];
  /** Customer-email privacy: the same list as opaque ids + viewer-visible labels. Preferred over `contactEmails`. */
  contactRecipients?: RecipientOption[];
}) {
  // Only a genuinely ACTIVE enrollment blocks (and is offered as "active"); FAILED / UNSUBSCRIBED / COMPLETED are history and never hide a sequence from the picker.
  const { active, history } = splitEnrollments(enrollments);
  const activeSequenceIds = new Set(active.map((e) => e.sequence.id));
  const applicable = availableSequences.filter((s) => !activeSequenceIds.has(s.id));

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ApplySequenceDialog leadId={leadId} sequences={applicable} contactEmails={contactEmails} contactRecipients={contactRecipients} />
      </div>

      {enrollments.length === 0 ? (
        <EmptyState icon={Mail} title="No sequences applied" description="Apply a saved sequence to start following up with this lead automatically." />
      ) : (
        <>
          {active.length > 0 && (
            <section aria-label="Active sequences" className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active</h3>
              <ul className="space-y-2">
                {active.map((e) => (
                  <ActiveSequenceCard key={e.id} enrollment={e} leadId={leadId} />
                ))}
              </ul>
            </section>
          )}
          {history.length > 0 && (
            <section aria-label="Sequence history" className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h3>
              <ul className="space-y-2">
                {history.map((e) => {
                  const state = enrollmentStateOf(e);
                  return (
                    <li key={e.id} className="rounded-md border px-3 py-2.5 space-y-1.5" data-testid="sequence-history-item">
                      <div className="flex items-center justify-between gap-2">
                        <Link href={`/sequences/${e.sequence.id}`} className="text-sm font-medium hover:underline">
                          {e.sequence.name}
                        </Link>
                        <StatusBadge label={state.label} tone={state.tone} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Applied {formatDistanceToNow(e.enrolledAt, { addSuffix: true })} by {e.enrolledBy?.fullName ?? "System"}
                      </p>
                      <p className="text-xs text-muted-foreground">{historyDetail(e)}</p>
                      {e.status === "FAILED" && <EnrollmentRecoveryActions enrollmentId={e.id} leadId={leadId} state={state.key} sequenceName={e.sequence.name} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
