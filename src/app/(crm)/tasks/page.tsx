import Link from "next/link";
import { notFound } from "next/navigation";
import { ListChecks } from "lucide-react";
import { getTasks } from "@/server/queries/tasks";
import { listTaskEligibleAgents } from "@/server/queries/reference-data";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewTasks, canViewAllRecords } from "@/lib/permissions";
import { EmptyState } from "@/components/crm/empty-state";
import { CountdownBadge } from "@/components/crm/countdown-badge";
import { StatusBadge } from "@/components/crm/status-badge";
import { TaskFilters } from "@/components/tasks/task-filters";
import { NewTaskDialog } from "@/components/tasks/new-task-dialog";
import { ProcessDueTasksButton } from "@/components/tasks/process-due-tasks-button";
import { TaskCompleteCheckbox, TaskDeleteButton } from "@/components/tasks/task-row-actions";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { cn } from "@/lib/utils";
import { PRIORITY_META } from "@/lib/status-meta";
import type { TaskStatus, Priority } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function TasksPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;

  const currentAccount = await getCurrentAccount();
  if (!canViewTasks(currentAccount?.role)) notFound();

  // Part 18 — "My Tasks / All Tasks / Specific User", only meaningful for a
  // company-wide viewer; defaults to "My Tasks". A restricted viewer's
  // results are unaffected by this regardless (see taskVisibilityWhere).
  const canScopeByUser = canViewAllRecords(currentAccount?.role);
  const scopeParam = typeof sp.scope === "string" ? sp.scope : "mine";
  const scopeUserId = !canScopeByUser ? undefined : scopeParam === "all" ? undefined : scopeParam === "mine" ? currentAccount!.id : scopeParam;

  const [{ tasks, total, pageCount, pageSize: effectivePageSize }, agents] = await Promise.all([
    getTasks({
      q: typeof sp.q === "string" ? sp.q : undefined,
      status: typeof sp.status === "string" ? (sp.status as TaskStatus) : undefined,
      scopeUserId,
      priority: typeof sp.priority === "string" ? (sp.priority as Priority) : undefined,
      due: typeof sp.due === "string" ? (sp.due as "overdue" | "today" | "week" | "no_date") : undefined,
      sort: typeof sp.sort === "string" ? (sp.sort as "due_asc" | "due_desc" | "created_desc" | "created_asc") : undefined,
      page,
      pageSize,
    }, currentAccount),
    currentAccount ? listTaskEligibleAgents(currentAccount.companyId) : Promise.resolve([]),
  ]);
  redirectToValidPageIfNeeded(sp, "/tasks", page, pageCount);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground">{total} task{total === 1 ? "" : "s"}</p>
        </div>
        <div className="flex items-center gap-2">
          <ProcessDueTasksButton />
          <NewTaskDialog agents={agents} currentAgentId={currentAccount?.id} />
        </div>
      </div>

      <TaskFilters agents={agents} canScopeByUser={canScopeByUser} />

      {tasks.length === 0 ? (
        <EmptyState icon={ListChecks} title="No tasks found" description="Try adjusting your filters, or create a new task to get started." />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>Task</TableHead>
                <TableHead>Related To</TableHead>
                <TableHead>Assignee</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Due</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => {
                const relatedContact = t.contact ?? t.lead?.contact ?? null;
                const relatedHref = t.leadId ? `/leads/${t.leadId}` : t.contactId ? `/contacts/${t.contactId}` : null;
                return (
                  <TableRow key={t.id} className="hover:bg-muted/40">
                    <TableCell>
                      <TaskCompleteCheckbox taskId={t.id} status={t.status} />
                    </TableCell>
                    <TableCell>
                      <Link href={`/tasks/${t.id}`} className={cn("font-medium hover:underline hover:text-primary", t.status === "COMPLETED" && "line-through text-muted-foreground")}>
                        {t.title}
                      </Link>
                      {t.notes && <p className="text-xs text-muted-foreground truncate max-w-xs">{t.notes}</p>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {relatedContact && relatedHref ? (
                        <Link href={relatedHref} className="hover:underline hover:text-primary">
                          {relatedContact.firstName} {relatedContact.lastName}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{t.assignee?.fullName ?? "Unassigned"}</TableCell>
                    <TableCell><StatusBadge label={PRIORITY_META[t.priority].label} tone={PRIORITY_META[t.priority].tone} /></TableCell>
                    <TableCell><CountdownBadge dueAt={t.dueAt} status={t.status} /></TableCell>
                    <TableCell>
                      <TaskDeleteButton taskId={t.id} title={t.title} />
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
