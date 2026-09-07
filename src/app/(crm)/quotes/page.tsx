import Link from "next/link";
import { notFound } from "next/navigation";
import { FileText } from "lucide-react";
import { formatShortTimestamp } from "@/lib/datetime-format";
import { getQuotes } from "@/server/queries/quotes";
import { listTaskEligibleAgents } from "@/server/queries/reference-data";
import { getCurrentAccount } from "@/lib/dev-session";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { QUOTE_STATUS_META } from "@/lib/status-meta";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusFilterSelect } from "@/components/crm/status-filter-select";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { parseStatusListParam } from "@/lib/status-filter";
import { canViewAllQuotesAndBookings, canViewQuotesPage } from "@/lib/permissions";
import { getPassengerCount } from "@/lib/passengers";
import type { QuoteStatus } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

// Derived from the centralized QUOTE_STATUS_META map (never a hand-kept
// duplicate list) — TypeScript's exhaustiveness check on that Record
// already forces every QuoteStatus enum member to have a label/tone
// entry, so any FUTURE status added to the schema automatically appears
// in this filter with zero changes needed here.
const STATUSES = Object.keys(QUOTE_STATUS_META) as QuoteStatus[];

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function QuotesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;
  const status = parseStatusListParam<QuoteStatus>(typeof sp.status === "string" ? sp.status : undefined);

  const currentAccount = await getCurrentAccount();
  if (!canViewQuotesPage(currentAccount?.role)) notFound();
  const viewer = currentAccount ? { id: currentAccount.id, role: currentAccount.role, companyId: currentAccount.companyId } : null;
  // Same reasoning as Leads' own agent filter: this only narrows within a
  // viewer's own quoteVisibilityWhere scope, never widens it — but there's
  // no point offering (or honoring) it for someone who can only ever see
  // their own quotes anyway.
  const canFilterByAgent = canViewAllQuotesAndBookings(currentAccount?.role);
  const agentId = canFilterByAgent && typeof sp.agent === "string" ? sp.agent : undefined;

  const [{ quotes, total, pageCount, pageSize: effectivePageSize }, agents] = await Promise.all([
    getQuotes({ status, agentId, page, pageSize, viewer }),
    canFilterByAgent && currentAccount ? listTaskEligibleAgents(currentAccount.companyId) : Promise.resolve([]),
  ]);
  redirectToValidPageIfNeeded(sp, "/quotes", page, pageCount);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Quotes</h1>
        <p className="text-sm text-muted-foreground">{total} quote{total === 1 ? "" : "s"}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusFilterSelect options={STATUSES.map((s) => ({ value: s, label: QUOTE_STATUS_META[s].label }))} multiple />
        {canFilterByAgent && (
          <StatusFilterSelect
            paramKey="agent"
            placeholder="Agent"
            allLabel="All agents"
            options={agents.map((a) => ({ value: a.id, label: a.fullName }))}
          />
        )}
      </div>

      {quotes.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No Quotes Yet"
          description="Create a quote from a lead to get started."
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Quote #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Route</TableHead>
                <TableHead className="text-right">Passengers</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Viewed</TableHead>
                <TableHead>Signed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quotes.map((q) => {
                const meta = QUOTE_STATUS_META[q.status];
                const seg = q.itinerary?.segments[0];
                return (
                  <TableRow key={q.id} className="hover:bg-muted/40">
                    <TableCell>
                      <Link href={`/quotes/${q.id}`} className="font-medium hover:underline hover:text-primary">
                        {q.quoteNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">{q.contact.firstName} {q.contact.lastName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{q.agent?.fullName ?? "—"}</TableCell>
                    <TableCell className="text-sm">{seg ? `${seg.departureAirport.iata} → ${seg.arrivalAirport.iata}` : "—"}</TableCell>
                    <TableCell className="text-sm text-right tabular-nums">{getPassengerCount(q)}</TableCell>
                    <TableCell className="text-sm">${Number(q.total).toLocaleString()}</TableCell>
                    <TableCell><StatusBadge label={meta.label} tone={meta.tone} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{q.sentAt ? formatShortTimestamp(q.sentAt) : "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{q.viewedAt ? formatShortTimestamp(q.viewedAt) : "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{q.signedAt ? formatShortTimestamp(q.signedAt) : "—"}</TableCell>
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
