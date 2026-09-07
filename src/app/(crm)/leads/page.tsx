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
import { CallButton } from "@/components/crm/call-button";
import { EmailComposerButton } from "@/components/crm/email-composer-dialog";
import { ReassignIconTrigger } from "@/components/crm/reassign-icon-trigger";
import { ReassignLeadDialog } from "@/components/leads/reassign-lead-dialog";
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
        <div className="rounded-lg border bg-card overflow-x-auto">
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
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => {
                const priority = PRIORITY_META[lead.priority];
                return (
                  <TableRow key={lead.id} className="hover:bg-muted/40">
                    <TableCell>
                      <Link href={`/leads/${lead.id}`} className="font-medium hover:underline hover:text-primary">
                        {lead.contact.firstName} {lead.contact.lastName}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {lead.contact.primaryEmail || (lead.contact.primaryPhone ? formatPhoneInternational(lead.contact.primaryPhone) : null)}
                      </p>
                    </TableCell>
                    <TableCell className="text-sm">
                      {lead.departureAirport?.iata ?? "—"} → {lead.arrivalAirport?.iata ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {lead.departureDate ? format(lead.departureDate, "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell className="text-sm">{lead.assignedAgent?.fullName ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                    <TableCell>
                      <StatusBadge label={priority.label} tone={priority.tone} className="text-sm" />
                    </TableCell>
                    <TableCell>
                      <LeadStatusSelect leadId={lead.id} status={lead.status} badgeClassName="text-sm" viewerRole={currentAccount?.role} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {formatDistanceToNow(lead.createdAt, { addSuffix: true })}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <CallButton phone={lead.contact.primaryPhone} />
                        <EmailComposerButton
                          leadId={lead.id}
                          emails={lead.contact.primaryEmail ? [lead.contact.primaryEmail] : []}
                          contactName={`${lead.contact.firstName} ${lead.contact.lastName}`}
                        />
                        {(canReassign || !lead.assignedAgentId) && (
                          <ReassignLeadDialog
                            leadId={lead.id}
                            leadLabel={`${lead.contact.firstName} ${lead.contact.lastName}`}
                            currentOwnerId={lead.assignedAgentId}
                            currentOwnerName={lead.assignedAgent?.fullName ?? null}
                            agents={agents}
                            trigger={<ReassignIconTrigger label={lead.assignedAgentId ? "Reassign Lead" : "Assign Lead"} />}
                          />
                        )}
                      </div>
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
