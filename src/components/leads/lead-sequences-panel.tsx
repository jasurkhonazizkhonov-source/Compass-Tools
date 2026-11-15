import Link from "next/link";
import { formatDistanceToNow, format } from "date-fns";
import { Mail } from "lucide-react";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { ApplySequenceDialog } from "@/components/sequences/apply-sequence-dialog";
import { ActiveSequenceCard, splitEnrollments, stepLabel, type LeadEnrollment } from "@/components/leads/active-sequences";
import { ENROLLMENT_STATUS_META } from "@/lib/status-meta";

/** What a non-active enrollment looks like in the history list: never a "next email", always where it stopped. */
function historyDetail(e: LeadEnrollment): string {
  if (e.status === "COMPLETED") return `Completed${e.completedAt ? ` ${format(e.completedAt, "MMM d, yyyy")}` : ""}`;
  if (e.status === "FAILED") return `Stopped at ${stepLabel(e).toLowerCase()} - no further emails will be sent`;
  return `Unsubscribed at ${stepLabel(e).toLowerCase()} - no further emails will be sent`; // UNSUBSCRIBED: unenrolled by staff or the customer's own unsubscribe link
}

export function LeadSequencesPanel({
  leadId,
  enrollments,
  availableSequences,
  contactEmails = [],
}: {
  leadId: string;
  enrollments: LeadEnrollment[];
  availableSequences: { id: string; name: string; description: string | null; stepCount: number; firstStepDelayMinutes?: number }[];
  /** Every email on file for this lead's contact, primary first — passed
   * through to ApplySequenceDialog's recipient picker (Part 4). */
  contactEmails?: string[];
}) {
  // Only a genuinely ACTIVE enrollment blocks (and is offered as "active"); FAILED / UNSUBSCRIBED / COMPLETED are history and never hide a sequence from the picker.
  const { active, history } = splitEnrollments(enrollments);
  const activeSequenceIds = new Set(active.map((e) => e.sequence.id));
  const applicable = availableSequences.filter((s) => !activeSequenceIds.has(s.id));

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ApplySequenceDialog leadId={leadId} sequences={applicable} contactEmails={contactEmails} />
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
                  const meta = ENROLLMENT_STATUS_META[e.status];
                  return (
                    <li key={e.id} className="rounded-md border px-3 py-2.5 space-y-1.5" data-testid="sequence-history-item">
                      <div className="flex items-center justify-between gap-2">
                        <Link href={`/sequences/${e.sequence.id}`} className="text-sm font-medium hover:underline">
                          {e.sequence.name}
                        </Link>
                        <StatusBadge label={meta.label} tone={meta.tone} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Applied {formatDistanceToNow(e.enrolledAt, { addSuffix: true })} by {e.enrolledBy?.fullName ?? "System"}
                      </p>
                      <p className="text-xs text-muted-foreground">{historyDetail(e)}</p>
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
