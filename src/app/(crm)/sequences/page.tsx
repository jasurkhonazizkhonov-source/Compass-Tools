import Link from "next/link";
import { notFound } from "next/navigation";
import { Mail } from "lucide-react";
import { getSequences } from "@/server/queries/sequences";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { listLeadEligibleAgents } from "@/server/queries/reference-data";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSequencesPage, canManageAllSequences } from "@/lib/permissions";
import { EmptyState } from "@/components/crm/empty-state";
import { NewSequenceDialog } from "@/components/sequences/new-sequence-dialog";
import { SequenceDeleteButton } from "@/components/sequences/sequence-row-actions";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SequencesPage({ searchParams }: { searchParams: SearchParams }) {
  const currentAccount = await getCurrentAccount();
  if (!canViewSequencesPage(currentAccount?.role)) notFound();

  // Part 19 — "My Sequences / All Sequences / Specific User", defaulting to
  // My Sequences, only meaningful for a company-wide viewer (Admin/Manager).
  // The specific-user list is restricted to users who actually have
  // Sequence-feature access (listLeadEligibleAgents excludes exactly the
  // same roles canViewSequencesPage does — Ticketing Agent/Flight Expert/
  // Marketing Agent).
  const canScopeByUser = canManageAllSequences(currentAccount?.role);
  const sp = await searchParams;
  const scopeParam = typeof sp.scope === "string" ? sp.scope : "mine";
  const scopeUserId = !canScopeByUser ? undefined : scopeParam === "all" ? undefined : scopeParam === "mine" ? currentAccount!.id : scopeParam;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;

  const [{ sequences, total, pageCount, pageSize: effectivePageSize }, eligibleAgents] = await Promise.all([
    getSequences({ viewer: currentAccount, scopeUserId, page, pageSize }),
    canScopeByUser ? listLeadEligibleAgents(currentAccount!.companyId) : Promise.resolve([]),
  ]);
  redirectToValidPageIfNeeded(sp, "/sequences", page, pageCount);
  // Part 12/19: the "Owner" column only appears while actually viewing
  // company-wide ("All Sequences") — every row would trivially share the
  // same owner under "My Sequences" or a single "Specific User" selection,
  // and a restricted viewer never sees anyone else's sequences at all.
  const showOwnerColumn = canManageAllSequences(currentAccount?.role) && scopeParam === "all";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sequences</h1>
          <p className="text-sm text-muted-foreground">{total} sequence{total === 1 ? "" : "s"}</p>
        </div>
        <NewSequenceDialog />
      </div>

      {canScopeByUser && (
        <div className="flex gap-1 rounded-md border bg-card p-1 w-full max-w-full overflow-x-auto sm:w-fit">
          <Link
            href="/sequences?scope=mine"
            className={cn("shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors", scopeParam === "mine" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
          >
            My Sequences
          </Link>
          <Link
            href="/sequences?scope=all"
            className={cn("shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors", scopeParam === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
          >
            All Sequences
          </Link>
          {eligibleAgents.map((a) => (
            <Link
              key={a.id}
              href={`/sequences?scope=${a.id}`}
              className={cn("shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors", scopeParam === a.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              {a.fullName}
            </Link>
          ))}
        </div>
      )}

      {sequences.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No sequences yet"
          description="Create a sequence to automatically follow up with leads over time."
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Active Enrollments</TableHead>
                <TableHead>Total Enrolled</TableHead>
                {showOwnerColumn && <TableHead>Owner</TableHead>}
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sequences.map((s) => {
                const canDelete = canManageAllSequences(currentAccount?.role) || s.createdById === currentAccount?.id;
                return (
                  <TableRow key={s.id} className="hover:bg-muted/40">
                    <TableCell>
                      <Link href={`/sequences/${s.id}`} className="font-medium hover:underline hover:text-primary">
                        {s.name}
                      </Link>
                      {s.description && <p className="text-xs text-muted-foreground">{s.description}</p>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={s.isActive ? "default" : "outline"}>{s.isActive ? "Active" : "Inactive"}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{s.steps.length}</TableCell>
                    <TableCell className="text-sm">{s.enrollments.length}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s._count.enrollments}</TableCell>
                    {showOwnerColumn && (
                      <TableCell className="text-sm text-muted-foreground">{s.createdBy?.fullName ?? "—"}</TableCell>
                    )}
                    <TableCell>
                      {canDelete && <SequenceDeleteButton sequenceId={s.id} name={s.name} />}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <PaginationControls page={page} pageCount={pageCount} total={total} pageSize={effectivePageSize} />
    </div>
  );
}
