import Link from "next/link";
import { notFound } from "next/navigation";
import { PlaneTakeoff } from "lucide-react";
import { formatShortTimestamp } from "@/lib/datetime-format";
import { getBookings } from "@/server/queries/bookings";
import { listTaskEligibleAgents } from "@/server/queries/reference-data";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewAllQuotesAndBookings, canViewBookings } from "@/lib/permissions";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { BOOKING_STATUS_META } from "@/lib/status-meta";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusFilterSelect } from "@/components/crm/status-filter-select";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { parseStatusListParam } from "@/lib/status-filter";
import { getPassengerCount } from "@/lib/passengers";
import { getBookingType, BOOKING_TYPE_LABELS } from "@/lib/booking-type";
import { Badge } from "@/components/ui/badge";
import type { BookingStatus } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

// Derived from the centralized BOOKING_STATUS_META map — see quotes/page.tsx's
// identical comment on why this is preferable to a hand-kept array.
const STATUSES = Object.keys(BOOKING_STATUS_META) as BookingStatus[];

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function BookingsPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;
  const status = parseStatusListParam<BookingStatus>(typeof sp.status === "string" ? sp.status : undefined);

  const currentAccount = await getCurrentAccount();
  if (!canViewBookings(currentAccount?.role)) notFound();
  const viewer = currentAccount ? { id: currentAccount.id, role: currentAccount.role, companyId: currentAccount.companyId } : null;
  // Same reasoning as Quotes' own agent filter (see quotes/page.tsx).
  const canFilterByAgent = canViewAllQuotesAndBookings(currentAccount?.role);
  const agentId = canFilterByAgent && typeof sp.agent === "string" ? sp.agent : undefined;

  const [{ bookings, total, pageCount, pageSize: effectivePageSize }, agents] = await Promise.all([
    getBookings({ status, agentId, page, pageSize, viewer }),
    canFilterByAgent && currentAccount ? listTaskEligibleAgents(currentAccount.companyId) : Promise.resolve([]),
  ]);
  redirectToValidPageIfNeeded(sp, "/bookings", page, pageCount);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Bookings</h1>
        <p className="text-sm text-muted-foreground">{total} booking{total === 1 ? "" : "s"}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusFilterSelect options={STATUSES.map((s) => ({ value: s, label: BOOKING_STATUS_META[s].label }))} multiple />
        {canFilterByAgent && (
          <StatusFilterSelect
            paramKey="agent"
            placeholder="Agent"
            allLabel="All agents"
            options={agents.map((a) => ({ value: a.id, label: a.fullName }))}
          />
        )}
      </div>

      {bookings.length === 0 ? (
        <EmptyState icon={PlaneTakeoff} title="No bookings yet" description="Completed customer bookings will appear here." />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Passengers</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bookings.map((b) => {
                const meta = BOOKING_STATUS_META[b.status];
                const seg = b.quote.itinerary?.segments[0];
                const bookingType = getBookingType(b.quote);
                return (
                  <TableRow key={b.id} className="hover:bg-muted/40">
                    <TableCell>
                      <Link href={`/bookings/${b.id}`} className="font-medium hover:underline hover:text-primary">
                        {b.bookingReference}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          bookingType === "CANCELLATION"
                            ? "border-destructive/40 text-destructive"
                            : bookingType === "EXCHANGE"
                              ? "border-info/40 text-info"
                              : ""
                        }
                      >
                        {BOOKING_TYPE_LABELS[bookingType]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{b.contact.firstName} {b.contact.lastName}</TableCell>
                    <TableCell className="text-sm">{seg ? `${seg.departureAirport.iata} → ${seg.arrivalAirport.iata}` : "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{b.lead.assignedAgent?.fullName ?? "—"}</TableCell>
                    <TableCell className="text-sm text-right tabular-nums">{getPassengerCount(b.quote)}</TableCell>
                    <TableCell className="text-sm">${Number(b.totalAmount).toLocaleString()}</TableCell>
                    <TableCell><StatusBadge label={meta.label} tone={meta.tone} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatShortTimestamp(b.createdAt)}</TableCell>
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
