import Link from "next/link";
import { formatDistanceToNow, format } from "date-fns";
import { Mail } from "lucide-react";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { ApplySequenceDialog } from "@/components/sequences/apply-sequence-dialog";
import { ENROLLMENT_STATUS_META } from "@/lib/status-meta";

type Enrollment = {
  id: string;
  status: "ACTIVE" | "COMPLETED" | "UNSUBSCRIBED" | "FAILED";
  currentStepIdx: number;
  enrolledAt: Date;
  nextSendAt: Date | null;
  completedAt: Date | null;
  sequence: { id: string; name: string; steps: { id: string }[] };
  enrolledBy: { fullName: string } | null;
};

export function LeadSequencesPanel({
  leadId,
  enrollments,
  availableSequences,
  contactEmails = [],
}: {
  leadId: string;
  enrollments: Enrollment[];
  availableSequences: { id: string; name: string; description: string | null; stepCount: number }[];
  /** Every email on file for this lead's contact, primary first — passed
   * through to ApplySequenceDialog's recipient picker (Part 4). */
  contactEmails?: string[];
}) {
  const activeSequenceIds = new Set(enrollments.filter((e) => e.status === "ACTIVE").map((e) => e.sequence.id));
  const applicable = availableSequences.filter((s) => !activeSequenceIds.has(s.id));

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <ApplySequenceDialog leadId={leadId} sequences={applicable} contactEmails={contactEmails} />
      </div>

      {enrollments.length === 0 ? (
        <EmptyState icon={Mail} title="No sequences applied" description="Apply a saved sequence to start following up with this lead automatically." />
      ) : (
        <ul className="space-y-2">
          {enrollments.map((e) => {
            const meta = ENROLLMENT_STATUS_META[e.status];
            const totalSteps = e.sequence.steps.length;
            return (
              <li key={e.id} className="rounded-md border px-3 py-2.5 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Link href={`/sequences/${e.sequence.id}`} className="text-sm font-medium hover:underline">
                    {e.sequence.name}
                  </Link>
                  <StatusBadge label={meta.label} tone={meta.tone} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Applied {formatDistanceToNow(e.enrolledAt, { addSuffix: true })} by {e.enrolledBy?.fullName ?? "System"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {e.status === "COMPLETED"
                    ? `Completed${e.completedAt ? ` ${format(e.completedAt, "MMM d, yyyy")}` : ""}`
                    : `Step ${Math.min(e.currentStepIdx + 1, totalSteps)} of ${totalSteps}`}
                  {e.status === "ACTIVE" && e.nextSendAt && ` · Next: ${format(e.nextSendAt, "MMM d, yyyy h:mm a")}`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
