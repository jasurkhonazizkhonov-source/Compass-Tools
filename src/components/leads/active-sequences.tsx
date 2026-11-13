import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import { StatusBadge } from "@/components/crm/status-badge";
import { ENROLLMENT_STATUS_META } from "@/lib/status-meta";
import { UnenrollSequenceButton } from "@/components/leads/unenroll-sequence-button";

export type LeadEnrollment = {
  id: string;
  status: "ACTIVE" | "COMPLETED" | "UNSUBSCRIBED" | "FAILED";
  currentStepIdx: number;
  enrolledAt: Date;
  nextSendAt: Date | null;
  completedAt: Date | null;
  sequence: { id: string; name: string; steps: { id: string }[] };
  enrolledBy: { fullName: string } | null;
};

/** "Step 2 of 5", never past the last step. */
export function stepLabel(e: Pick<LeadEnrollment, "currentStepIdx" | "sequence">): string {
  const total = e.sequence.steps.length;
  return `Step ${Math.min(e.currentStepIdx + 1, Math.max(total, 1))} of ${total}`;
}

/**
 * One GENUINELY active enrollment: status, who/when, which step, when the next email goes out, and the Unenroll action. Only ever rendered for
 * enrollments whose status is ACTIVE - a failed, unenrolled or completed one is history, never shown here (see splitEnrollments).
 */
export function ActiveSequenceCard({ enrollment: e, leadId }: { enrollment: LeadEnrollment; leadId: string }) {
  const meta = ENROLLMENT_STATUS_META.ACTIVE;
  return (
    <li className="rounded-md border px-3 py-2.5 space-y-1.5" data-testid="active-sequence">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/sequences/${e.sequence.id}`} className="text-sm font-medium hover:underline">
          {e.sequence.name}
        </Link>
        <StatusBadge label={meta.label} tone={meta.tone} />
      </div>
      <p className="text-xs text-muted-foreground">
        Applied {formatDistanceToNow(e.enrolledAt, { addSuffix: true })} by {e.enrolledBy?.fullName ?? "System"}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {stepLabel(e)}
          {e.nextSendAt && ` · Next email: ${format(e.nextSendAt, "MMM d, yyyy 'at' h:mm a")}`}
        </p>
        <UnenrollSequenceButton enrollmentId={e.id} leadId={leadId} sequenceName={e.sequence.name} />
      </div>
    </li>
  );
}

/** Only ACTIVE enrollments count as active; everything else is history. */
export function splitEnrollments(enrollments: LeadEnrollment[]) {
  return { active: enrollments.filter((e) => e.status === "ACTIVE"), history: enrollments.filter((e) => e.status !== "ACTIVE") };
}

/**
 * The notice shown when a lead's profile opens: one card per genuinely active enrollment, or nothing at all when there is none. Compact, and
 * deliberately not an alert - it is status, not an emergency.
 */
export function LeadActiveSequencesNotice({ leadId, enrollments }: { leadId: string; enrollments: LeadEnrollment[] }) {
  const { active } = splitEnrollments(enrollments);
  if (active.length === 0) return null;
  return (
    <section aria-labelledby="active-sequences-heading" className="rounded-lg border border-info/30 bg-info/5 p-3 space-y-2" data-testid="active-sequences-notice">
      <h2 id="active-sequences-heading" className="text-sm font-semibold">
        {active.length === 1 ? "Active sequence" : `Active sequences (${active.length})`}
      </h2>
      <ul className="space-y-2">
        {active.map((e) => (
          <ActiveSequenceCard key={e.id} enrollment={e} leadId={leadId} />
        ))}
      </ul>
    </section>
  );
}
