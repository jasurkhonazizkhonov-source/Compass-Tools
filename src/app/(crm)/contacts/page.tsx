import Link from "next/link";
import { notFound } from "next/navigation";
import { Contact2 } from "lucide-react";
import { getContacts } from "@/server/queries/contacts";
import { listLeadEligibleAgents } from "@/server/queries/reference-data";
import { getCurrentAccount } from "@/lib/dev-session";
import { canReassignLeads, canViewAllRecords, canViewContacts } from "@/lib/permissions";
import { EmptyState } from "@/components/crm/empty-state";
import { CallButton } from "@/components/crm/call-button";
import { ReassignIconTrigger } from "@/components/crm/reassign-icon-trigger";
import { ReassignContactDialog } from "@/components/contacts/reassign-contact-dialog";
import { ContactFilters } from "@/components/contacts/contact-filters";
import { StatusBadge } from "@/components/crm/status-badge";
import { LEAD_STATUS_META } from "@/lib/status-meta";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { formatPhoneInternational } from "@/lib/phone";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ContactsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;
  const q = typeof sp.q === "string" ? sp.q : undefined;

  const currentAccount = await getCurrentAccount();
  if (!canViewContacts(currentAccount?.role)) notFound();
  const viewer = currentAccount ? { id: currentAccount.id, role: currentAccount.role, companyId: currentAccount.companyId } : null;
  const canReassign = canReassignLeads(currentAccount?.role);
  // Same reasoning as Leads' own `canFilterByOtherAgents` (see leads/page.tsx):
  // the Agent filter only ever narrows within a viewer's own visibility
  // scope, but there's no point offering it to someone who can only ever
  // see their own contacts anyway.
  const canFilterByOtherAgents = canViewAllRecords(currentAccount?.role);

  const [{ contacts, total, pageCount, pageSize: effectivePageSize }, agents] = await Promise.all([
    getContacts({
      q,
      agentId: canFilterByOtherAgents && typeof sp.agent === "string" ? sp.agent : undefined,
      hasEmail: sp.hasEmail === "true" ? true : sp.hasEmail === "false" ? false : undefined,
      hasPhone: sp.hasPhone === "true" ? true : sp.hasPhone === "false" ? false : undefined,
      page,
      pageSize,
      viewer,
    }),
    (canReassign || canFilterByOtherAgents) && currentAccount ? listLeadEligibleAgents(currentAccount.companyId) : Promise.resolve([]),
  ]);
  redirectToValidPageIfNeeded(sp, "/contacts", page, pageCount);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
        <p className="text-sm text-muted-foreground">{total} customer{total === 1 ? "" : "s"}</p>
      </div>

      <ContactFilters agents={canFilterByOtherAgents ? agents : []} />

      {contacts.length === 0 ? (
        <EmptyState icon={Contact2} title="No contacts found" description="Contacts are created automatically when you add a lead." />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Leads</TableHead>
                <TableHead>Bookings</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((c) => (
                <TableRow key={c.id} className="hover:bg-muted/40">
                  <TableCell>
                    <Link href={`/contacts/${c.id}`} className="font-medium hover:underline hover:text-primary">
                      {c.firstName} {c.lastName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">{c.primaryPhone ? formatPhoneInternational(c.primaryPhone) : "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.primaryEmail ?? "—"}</TableCell>
                  <TableCell className="text-sm">
                    {c.owner ? c.owner.fullName : <span className="text-muted-foreground">Unassigned</span>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {c.leads.length === 0 && <span className="text-sm text-muted-foreground">0</span>}
                      {c.leads.slice(0, 3).map((l) => {
                        const meta = LEAD_STATUS_META[l.status];
                        return <StatusBadge key={l.id} label={meta.label} tone={meta.tone} />;
                      })}
                      {c.leads.length > 3 && (
                        <span className="text-xs text-muted-foreground self-center">+{c.leads.length - 3}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{c._count.bookings}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <CallButton phone={c.primaryPhone} />
                      {canReassign && (
                        <ReassignContactDialog
                          contactId={c.id}
                          contactName={`${c.firstName} ${c.lastName}`}
                          currentOwnerId={c.owner?.id ?? null}
                          currentOwnerName={c.owner?.fullName ?? null}
                          leads={c.leads.map((l) => ({
                            id: l.id,
                            route: `${l.departureAirport?.iata ?? "?"} → ${l.arrivalAirport?.iata ?? "?"}`,
                            ownerName: l.assignedAgent?.fullName ?? null,
                          }))}
                          agents={agents}
                          trigger={<ReassignIconTrigger label={c.owner?.id ? "Reassign Contact" : "Assign Contact"} />}
                        />
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <PaginationControls page={page} pageCount={pageCount} total={total} pageSize={effectivePageSize} />
    </div>
  );
}
