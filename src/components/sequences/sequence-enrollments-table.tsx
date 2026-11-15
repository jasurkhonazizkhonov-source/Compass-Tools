import Link from "next/link";
import { format } from "date-fns";
import { StatusBadge } from "@/components/crm/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UnenrollSequenceButton } from "@/components/leads/unenroll-sequence-button";
import { ENROLLMENT_STATUS_META } from "@/lib/status-meta";
import { computeStepProgress, STEP_PROGRESS_LABEL, type StepProgressStatus } from "@/lib/sequence-progress";

export type SequenceEnrollmentRow = {
  id: string;
  leadId: string;
  status: "ACTIVE" | "COMPLETED" | "UNSUBSCRIBED" | "FAILED";
  currentStepIdx: number;
  enrolledAt: Date;
  nextSendAt: Date | null;
  recipientEmail: string | null;
  /** False when the viewer may not see this lead: its contact's email is then withheld. */
  leadVisible: boolean;
  lead: { contact: { firstName: string; lastName: string; primaryEmail: string | null } };
  stepLogs: { stepId: string; status: "SENT" | "FAILED"; sentAt: Date | null; createdAt: Date; error: string | null }[];
};

const CHIP_TONE: Record<StepProgressStatus, string> = {
  sent: "border-success/40 bg-success/10 text-foreground",
  scheduled: "border-info/40 bg-info/10 text-foreground",
  paused: "border-warning/50 bg-warning/10 text-foreground",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  cancelled: "border-border bg-muted text-muted-foreground line-through",
  pending: "border-border bg-transparent text-muted-foreground",
};

const stamp = (d: Date) => format(d, "MMM d, yyyy h:mm a");

/**
 * Every lead enrolled in one sequence, with where each one is: per-step progress (sent / scheduled / pending / failed / cancelled / paused - taken from the
 * stored step log, never from "an attempt was made"), the last email that actually went out, when the next one is due, a plain note when something is wrong,
 * and an Unenroll action that behaves exactly like the one on the lead page. Unenrolling keeps the row and every sent-email record as history.
 */
export function SequenceEnrollmentsTable({
  enrollments,
  steps,
  sequenceName,
  sequenceActive,
  canUnenroll,
}: {
  enrollments: SequenceEnrollmentRow[];
  steps: { id: string }[];
  sequenceName: string;
  sequenceActive: boolean;
  canUnenroll: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border" data-testid="sequence-enrollments-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Lead</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Enrolled</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Last sent</TableHead>
            <TableHead>Next step</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {enrollments.map((e) => {
            const meta = ENROLLMENT_STATUS_META[e.status];
            const progress = computeStepProgress({ steps, enrollment: e, logs: e.stepLogs, sequenceActive });
            const sentCount = progress.filter((p) => p.status === "sent").length;
            const lastSent = progress.filter((p) => p.status === "sent" && p.at).sort((a, b) => b.at!.getTime() - a.at!.getTime())[0];
            const lastSentPosition = [...progress].reverse().find((p) => p.status === "sent")?.position;
            const waiting = progress.find((p) => p.status === "scheduled" || p.status === "paused" || (p.status === "failed" && p.retrying));
            const failedStep = progress.find((p) => p.status === "failed");
            const lastError = e.stepLogs.find((l) => l.status === "FAILED")?.error ?? null;
            const email = e.recipientEmail ?? e.lead.contact.primaryEmail;
            return (
              <TableRow key={e.id} data-testid="enrollment-row" data-status={e.status}>
                <TableCell className="whitespace-nowrap">
                  <Link href={`/leads/${e.leadId}`} className="font-medium hover:underline">
                    {e.lead.contact.firstName} {e.lead.contact.lastName}
                  </Link>
                </TableCell>
                <TableCell className="max-w-[16rem] truncate">{e.leadVisible ? (email ?? <span className="text-muted-foreground">No email</span>) : <span className="text-muted-foreground">Hidden</span>}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{stamp(e.enrolledAt)}</TableCell>
                <TableCell>
                  <StatusBadge label={meta.label} tone={meta.tone} />
                </TableCell>
                <TableCell>
                  <p className="text-xs text-muted-foreground whitespace-nowrap">
                    {sentCount} of {steps.length} sent
                  </p>
                  <ol className="mt-1 flex flex-wrap gap-1" aria-label={`Step progress for ${e.lead.contact.firstName} ${e.lead.contact.lastName}`}>
                    {progress.map((p) => (
                      <li
                        key={p.stepId}
                        className={`rounded border px-1.5 py-0.5 text-[11px] leading-4 ${CHIP_TONE[p.status]}`}
                        title={`Step ${p.position} - ${STEP_PROGRESS_LABEL[p.status]}${p.at ? ` (${stamp(p.at)})` : ""}`}
                      >
                        {p.position}: {STEP_PROGRESS_LABEL[p.status]}
                        {p.status === "failed" && p.retrying ? " (retrying)" : ""}
                      </li>
                    ))}
                  </ol>
                  {e.status === "FAILED" && failedStep && (
                    <p className="mt-1 text-xs text-destructive">Stopped at step {failedStep.position}{lastError ? `: ${lastError}` : ""}</p>
                  )}
                  {e.status === "ACTIVE" && !sequenceActive && <p className="mt-1 text-xs text-muted-foreground">Paused: the sequence is switched off.</p>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {lastSent?.at ? `Step ${lastSentPosition ?? lastSent.position} · ${stamp(lastSent.at)}` : lastSentPosition ? `Step ${lastSentPosition}` : <span className="text-muted-foreground">None yet</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {e.status === "ACTIVE" && waiting
                    ? sequenceActive
                      ? `Step ${waiting.position}${waiting.at ? ` · ${stamp(waiting.at)}` : ""}`
                      : `Step ${waiting.position} · paused`
                    : <span className="text-muted-foreground">{e.status === "ACTIVE" ? "-" : "No further steps"}</span>}
                </TableCell>
                <TableCell className="text-right">
                  {e.status === "ACTIVE" && canUnenroll ? <UnenrollSequenceButton enrollmentId={e.id} leadId={e.leadId} sequenceName={sequenceName} /> : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
