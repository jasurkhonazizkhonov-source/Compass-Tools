import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, Users } from "lucide-react";
import { getSequenceDetail, getSequenceEnrollments } from "@/server/queries/sequences";
import { listLeadsForEnrollment } from "@/server/queries/leads";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSequencesPage, canManageAllSequences } from "@/lib/permissions";
import { StepEditor } from "@/components/sequences/step-editor";
import { EnrollLeadsDialog } from "@/components/sequences/enroll-leads-dialog";
import { ProcessDueButton } from "@/components/sequences/process-due-button";
import { SequenceActiveToggle } from "@/components/sequences/sequence-active-toggle";
import { SequenceDeleteButton } from "@/components/sequences/sequence-row-actions";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ENROLLMENT_STATUS_META } from "@/lib/status-meta";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SequenceDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const sp = await searchParams;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;

  const currentAccount = await getCurrentAccount();
  if (!canViewSequencesPage(currentAccount?.role)) notFound();
  const viewer = currentAccount ? { id: currentAccount.id, role: currentAccount.role, companyId: currentAccount.companyId } : null;
  const [sequence, leads] = await Promise.all([getSequenceDetail(id, viewer), listLeadsForEnrollment(viewer)]);
  if (!sequence) notFound();
  const { enrollments, total: enrollmentTotal, pageCount: enrollmentPageCount, pageSize: enrollmentPageSize } = await getSequenceEnrollments({ sequenceId: id, viewer, page, pageSize });
  redirectToValidPageIfNeeded(sp, `/sequences/${id}`, page, enrollmentPageCount);
  const canDelete = canManageAllSequences(currentAccount?.role) || sequence.createdById === currentAccount?.id;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/sequences" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Sequences
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{sequence.name}</h1>
            {sequence.description && <p className="text-sm text-muted-foreground mt-1">{sequence.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SequenceActiveToggle sequenceId={sequence.id} isActive={sequence.isActive} />
            <ProcessDueButton />
            <EnrollLeadsDialog sequenceId={sequence.id} leads={leads} />
            {canDelete && <SequenceDeleteButton sequenceId={sequence.id} name={sequence.name} redirectTo="/sequences" />}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_1fr]">
        <Card className="shadow-none">
          <CardHeader><CardTitle className="text-sm font-medium">Steps</CardTitle></CardHeader>
          <CardContent>
            <StepEditor sequenceId={sequence.id} steps={sequence.steps} />
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader><CardTitle className="text-sm font-medium">Enrollments ({enrollmentTotal})</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {enrollments.length === 0 ? (
              <EmptyState icon={Users} title="No enrollments yet" description="Enroll leads to start sending this sequence." />
            ) : (
              <ul className="space-y-2">
                {enrollments.map((e) => (
                  <li key={e.id} className="rounded-md border px-3 py-2">
                    <div className="flex items-center justify-between">
                      <Link href={`/leads/${e.leadId}`} className="text-sm font-medium hover:underline">
                        {e.lead.contact.firstName} {e.lead.contact.lastName}
                      </Link>
                      <StatusBadge label={ENROLLMENT_STATUS_META[e.status].label} tone={ENROLLMENT_STATUS_META[e.status].tone} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Step {e.currentStepIdx + 1} of {sequence.steps.length} ·{" "}
                      {e.nextSendAt ? `Next: ${formatDistanceToNow(e.nextSendAt, { addSuffix: true })}` : "No further steps"}
                    </p>
                    {e.stepLogs.length > 0 && (
                      <div className="mt-1.5 flex gap-1 flex-wrap">
                        {e.stepLogs.slice(0, 3).map((log) => (
                          <Badge key={log.id} variant={log.status === "SENT" ? "outline" : "destructive"} className="text-[10px]">
                            {log.status === "SENT" ? "Sent" : "Failed"}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <PaginationControls page={page} pageCount={enrollmentPageCount} total={enrollmentTotal} pageSize={enrollmentPageSize} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
