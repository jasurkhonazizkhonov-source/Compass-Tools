import Link from "next/link";
import { notFound } from "next/navigation";
import { Contact2 } from "lucide-react";
import { getContacts } from "@/server/queries/contacts";
import { listLeadEligibleAgents } from "@/server/queries/reference-data";
import { getCurrentAccount } from "@/lib/dev-session";
import { canReassignLeads, canViewAllRecords, canViewContacts } from "@/lib/permissions";
import { EmptyState } from "@/components/crm/empty-state";
import { ContactRowActions } from "@/components/contacts/contact-row-actions";
import { ContactFilters } from "@/components/contacts/contact-filters";
import { StatusBadge } from "@/components/crm/status-badge";
import { LEAD_STATUS_META } from "@/lib/status-meta";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { formatPhoneInternational } from "@/lib/phone";
import { formatRelativeUpdated } from "@/lib/relative-time";
import { format } from "date-fns";

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
        <>
          {/* Tablet/desktop: the table, with the actions column pinned to the
              right edge so Call / Email / Reassign / Delete stay visible however
              far the other columns have to scroll. */}
          <div className="hidden md:block rounded-lg border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Leads</TableHead>
                  <TableHead>Bookings</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="sticky right-0 z-10 w-px bg-card shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.25)]">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map((c) => {
                  const contactName = `${c.firstName} ${c.lastName}`;
                  return (
                    <TableRow key={c.id} className="group hover:bg-muted/40">
                      <TableCell className="max-w-[200px]">
                        <Link href={`/contacts/${c.id}`} className="block truncate font-medium hover:underline hover:text-primary" title={contactName}>
                          {contactName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap">{c.primaryPhone ? formatPhoneInternational(c.primaryPhone) : "—"}</TableCell>
                      <TableCell className="max-w-[190px] truncate text-sm text-muted-foreground" title={c.primaryEmail ?? undefined}>{c.primaryEmail ?? "—"}</TableCell>
                      <TableCell className="text-sm whitespace-nowrap">
                        {c.owner ? c.owner.fullName : <span className="text-muted-foreground">Unassigned</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {c.leads.length === 0 && <span className="text-sm text-muted-foreground">0</span>}
                          {c.leads.slice(0, 3).map((l) => {
                            const meta = LEAD_STATUS_META[l.status];
                            return <StatusBadge key={l.id} label={meta.label} tone={meta.tone} />;
                          })}
                          {c.leads.length > 3 && <span className="text-xs text-muted-foreground self-center">+{c.leads.length - 3}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{c._count.bookings}</TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap" title={format(c.updatedAt, "MMM d, yyyy h:mm a")}>
                        {formatRelativeUpdated(c.updatedAt)}
                      </TableCell>
                      <TableCell className="sticky right-0 z-10 w-px bg-card group-hover:bg-[color-mix(in_srgb,var(--muted)_40%,var(--card))] shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.25)]">
                        <ContactRowActions
                          contactId={c.id}
                          contactName={contactName}
                          phone={c.primaryPhone}
                          email={c.primaryEmail}
                          ownerId={c.owner?.id ?? null}
                          ownerName={c.owner?.fullName ?? null}
                          leads={c.leads.map((l) => ({ id: l.id, route: `${l.departureAirport?.iata ?? "?"} → ${l.arrivalAirport?.iata ?? "?"}`, ownerName: l.assignedAgent?.fullName ?? null }))}
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

          {/* Phones: one card per contact — no horizontal scrolling, same four
              actions, labelled because touch screens have no tooltips. */}
          <ul className="space-y-3 md:hidden">
            {contacts.map((c) => {
              const contactName = `${c.firstName} ${c.lastName}`;
              return (
                <li key={c.id} className="rounded-lg border bg-card p-4 space-y-3">
                  <div className="min-w-0">
                    <Link href={`/contacts/${c.id}`} className="block break-words font-medium hover:underline hover:text-primary">
                      {contactName}
                    </Link>
                    <p className="break-all text-xs text-muted-foreground">{c.primaryEmail ?? (c.primaryPhone ? formatPhoneInternational(c.primaryPhone) : "—")}</p>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">Owner</dt>
                      <dd className="break-words">{c.owner ? c.owner.fullName : <span className="text-muted-foreground">Unassigned</span>}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Updated</dt>
                      <dd>{formatRelativeUpdated(c.updatedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Leads</dt>
                      <dd>{c._count.leads}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Bookings</dt>
                      <dd>{c._count.bookings}</dd>
                    </div>
                  </dl>
                  <div className="border-t pt-3">
                    <ContactRowActions
                      variant="labeled"
                      contactId={c.id}
                      contactName={contactName}
                      phone={c.primaryPhone}
                      email={c.primaryEmail}
                      ownerId={c.owner?.id ?? null}
                      ownerName={c.owner?.fullName ?? null}
                      leads={c.leads.map((l) => ({ id: l.id, route: `${l.departureAirport?.iata ?? "?"} → ${l.arrivalAirport?.iata ?? "?"}`, ownerName: l.assignedAgent?.fullName ?? null }))}
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
