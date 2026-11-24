import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Users } from "lucide-react";
import { getSequenceDetail, getSequenceEnrollments } from "@/server/queries/sequences";
import { listLeadsForEnrollment } from "@/server/queries/leads";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSequencesPage, canManageAllSequences, canManageSequences } from "@/lib/permissions";
import { StepEditor } from "@/components/sequences/step-editor";
import { EnrollLeadsDialog } from "@/components/sequences/enroll-leads-dialog";
import { EnrollAllContactsDialog } from "@/components/sequences/enroll-all-contacts-dialog";
import { SequenceEnrollmentsTable } from "@/components/sequences/sequence-enrollments-table";
import { SequenceActiveToggle } from "@/components/sequences/sequence-active-toggle";
import { SequenceDeleteButton } from "@/components/sequences/sequence-row-actions";
import { EmptyState } from "@/components/crm/empty-state";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
  // Real performance issue found and fixed: getSequenceEnrollments only
  // ever depends on id/viewer/page/pageSize — none of which depend on
  // `sequence` or `leads` — but it used to be awaited only AFTER this
  // Promise.all resolved, adding one full extra sequential database
  // round-trip of latency to every sequence detail page load for no
  // reason. Merged into the same Promise.all so all three genuinely
  // independent queries run concurrently; the not-found check simply
  // moves after, keyed off the resolved `sequence`.
  const [sequence, leads, enrollmentPage] = await Promise.all([
    getSequenceDetail(id, viewer),
    listLeadsForEnrollment(viewer),
    getSequenceEnrollments({ sequenceId: id, viewer, page, pageSize }),
  ]);
  if (!sequence) notFound();
  const { enrollments, total: enrollmentTotal, pageCount: enrollmentPageCount, pageSize: enrollmentPageSize } = enrollmentPage;
  redirectToValidPageIfNeeded(sp, `/sequences/${id}`, page, enrollmentPageCount);
  const canDelete = canManageAllSequences(currentAccount?.role) || sequence.createdById === currentAccount?.id;
  const canUnenroll = canManageSequences(currentAccount?.role);
  const activeCount = enrollments.filter((e) => e.status === "ACTIVE").length;

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
            <EnrollLeadsDialog sequenceId={sequence.id} sequenceName={sequence.name} leads={leads} />
            {sequence.isActive && sequence.steps.length > 0 && canUnenroll && <EnrollAllContactsDialog sequenceId={sequence.id} sequenceName={sequence.name} />}
            {canDelete && <SequenceDeleteButton sequenceId={sequence.id} name={sequence.name} redirectTo="/sequences" />}
          </div>
        </div>
      </div>

      <Card className="shadow-none">
        <CardHeader><CardTitle className="text-sm font-medium">Steps</CardTitle></CardHeader>
        <CardContent>
          <StepEditor sequenceId={sequence.id} steps={sequence.steps} />
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Enrolled leads ({enrollmentTotal})
            {enrollmentTotal > 0 && <span className="ml-2 font-normal text-muted-foreground">{activeCount} active on this page</span>}
          </CardTitle>
          {!sequence.isActive && (
            <p className="text-xs text-muted-foreground" role="status">
              This sequence is switched off: no emails are being sent, and active enrollments resume if it is switched back on.
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {enrollments.length === 0 ? (
            <EmptyState icon={Users} title="No enrollments yet" description="Enroll leads to start sending this sequence." />
          ) : (
            <SequenceEnrollmentsTable
              enrollments={enrollments}
              steps={sequence.steps}
              sequenceName={sequence.name}
              sequenceActive={sequence.isActive}
              canUnenroll={canUnenroll}
            />
          )}
          <PaginationControls page={page} pageCount={enrollmentPageCount} total={enrollmentTotal} pageSize={enrollmentPageSize} />
        </CardContent>
      </Card>
    </div>
  );
}
