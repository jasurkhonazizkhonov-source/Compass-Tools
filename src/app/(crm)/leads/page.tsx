import Link from "next/link";
import { notFound } from "next/navigation";
import { format, formatDistanceToNow } from "date-fns";
import { Users } from "lucide-react";
import { getLeads } from "@/server/queries/leads";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { listLeadEligibleAgents } from "@/server/queries/reference-data";
import { getCurrentAccount } from "@/lib/dev-session";
import { canReassignLeads, canViewAllRecords, canViewLeads } from "@/lib/permissions";
import { LeadFilters } from "@/components/leads/lead-filters";
import { NewLeadDialog } from "@/components/leads/new-lead-dialog";
import { LeadStatusSelect } from "@/components/leads/lead-status-select";
import { LeadRowActions } from "@/components/leads/lead-row-actions";
import { StatusBadge } from "@/components/crm/status-badge";
import { EmptyState } from "@/components/crm/empty-state";
import { PRIORITY_META } from "@/lib/status-meta";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPhoneInternational } from "@/lib/phone";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import type { LeadStatus, CabinClass, TripType, LeadSource } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LeadsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;

  const currentAccount = await getCurrentAccount();
  if (!canViewLeads(currentAccount?.role)) notFound();
  const viewer = currentAccount ? { id: currentAccount.id, role: currentAccount.role, companyId: currentAccount.companyId } : null;
  const canReassign = canReassignLeads(currentAccount?.role);
  const canFilterByOtherAgents = canViewAllRecords(currentAccount?.role);

  const [{ leads, total, pageCount, pageSize: effectivePageSize }, agents] = await Promise.all([
    getLeads({
      q: typeof sp.q === "string" ? sp.q : undefined,
      status: typeof sp.status === "string" ? [sp.status as LeadStatus] : undefined,
      // The `?agent=` filter only ever narrows within a viewer's own
      // visibility scope — a restricted viewer can't use it to widen past
      // their own leads (leadVisibilityWhere already enforces that
      // server-side regardless), but there's no point sending a
      // now-meaningless param through for them either.
      agentId: canFilterByOtherAgents && typeof sp.agent === "string" ? sp.agent : undefined,
      cabinClass: typeof sp.cabin === "string" ? (sp.cabin as CabinClass) : undefined,
      tripType: typeof sp.trip === "string" ? (sp.trip as TripType) : undefined,
      source: typeof sp.source === "string" ? (sp.source as LeadSource) : undefined,
      page,
      pageSize,
      viewer,
    }),
    currentAccount ? listLeadEligibleAgents(currentAccount.companyId) : Promise.resolve([]),
  ]);
  redirectToValidPageIfNeeded(sp, "/leads", page, pageCount);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">{total} lead{total === 1 ? "" : "s"}</p>
        </div>
        <NewLeadDialog agents={agents} currentAccountId={currentAccount?.id} canAssignOthers={canReassign} />
      </div>

      <LeadFilters agents={agents} />

      {leads.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No leads found"
          description="Try adjusting your filters, or create a new lead to get started."
        />
      ) : (
        <>
          {/* Tablet/desktop: the table. The actions column is pinned to the right
              edge, so Call / Email / Reassign stay visible however far the
              other columns have to scroll. */}
          <div className="hidden md:block rounded-lg border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead>Travel Date</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="sticky right-0 z-10 w-px bg-card shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.25)]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((lead) => {
                  const priority = PRIORITY_META[lead.priority];
                  const customerName = `${lead.contact.firstName} ${lead.contact.lastName}`;
                  return (
                    <TableRow key={lead.id} className="group hover:bg-muted/40">
                      <TableCell className="max-w-[260px]">
                        <Link href={`/leads/${lead.id}`} className="block truncate font-medium hover:underline hover:text-primary" title={customerName}>
                          {customerName}
                        </Link>
                        <p className="truncate text-xs text-muted-foreground">
                          {lead.contact.primaryEmail || (lead.contact.primaryPhone ? formatPhoneInternational(lead.contact.primaryPhone) : null)}
                        </p>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {lead.departureAirport?.iata ?? "—"} → {lead.arrivalAirport?.iata ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {lead.departureDate ? format(lead.departureDate, "MMM d, yyyy") : "—"}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">{lead.assignedAgent?.fullName ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                      <TableCell>
                        <StatusBadge label={priority.label} tone={priority.tone} className="text-sm" />
                      </TableCell>
                      <TableCell>
                        <LeadStatusSelect leadId={lead.id} status={lead.status} badgeClassName="text-sm" viewerRole={currentAccount?.role} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {formatDistanceToNow(lead.createdAt, { addSuffix: true })}
                      </TableCell>
                      <TableCell className="sticky right-0 z-10 w-px bg-card group-hover:bg-[color-mix(in_srgb,var(--muted)_40%,var(--card))] shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.25)]">
                        <LeadRowActions
                          leadId={lead.id}
                          customerName={customerName}
                          phone={lead.contact.primaryPhone}
                          email={lead.contact.primaryEmail}
                          assignedAgentId={lead.assignedAgentId}
                          assignedAgentName={lead.assignedAgent?.fullName ?? null}
                          agents={agents}
                          viewerRole={currentAccount?.role}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Phones: one card per lead — no horizontal scrolling, and the same
              three actions (labelled, because touch screens have no tooltips). */}
          <ul className="space-y-3 md:hidden">
            {leads.map((lead) => {
              const priority = PRIORITY_META[lead.priority];
              const customerName = `${lead.contact.firstName} ${lead.contact.lastName}`;
              return (
                <li key={lead.id} className="rounded-lg border bg-card p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/leads/${lead.id}`} className="block break-words font-medium hover:underline hover:text-primary">
                        {customerName}
                      </Link>
                      <p className="break-all text-xs text-muted-foreground">
                        {lead.contact.primaryEmail || (lead.contact.primaryPhone ? formatPhoneInternational(lead.contact.primaryPhone) : null)}
                      </p>
                    </div>
                    <StatusBadge label={priority.label} tone={priority.tone} className="shrink-0 text-xs" />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Route</dt>
                      <dd>{lead.departureAirport?.iata ?? "—"} → {lead.arrivalAirport?.iata ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Travel date</dt>
                      <dd>{lead.departureDate ? format(lead.departureDate, "MMM d, yyyy") : "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Agent</dt>
                      <dd className="break-words">{lead.assignedAgent?.fullName ?? <span className="text-muted-foreground">Unassigned</span>}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Created</dt>
                      <dd>{formatDistanceToNow(lead.createdAt, { addSuffix: true })}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap items-end justify-between gap-3 border-t pt-3">
                    <LeadStatusSelect leadId={lead.id} status={lead.status} badgeClassName="text-sm" viewerRole={currentAccount?.role} />
                    <LeadRowActions
                      variant="labeled"
                      leadId={lead.id}
                      customerName={customerName}
                      phone={lead.contact.primaryPhone}
                      email={lead.contact.primaryEmail}
                      assignedAgentId={lead.assignedAgentId}
                      assignedAgentName={lead.assignedAgent?.fullName ?? null}
                      agents={agents}
                      viewerRole={currentAccount?.role}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <PaginationControls page={page} pageCount={pageCount} total={total} pageSize={effectivePageSize} />
    </div>
  );
}
