import { notFound } from "next/navigation";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Inbox } from "lucide-react";
import { getContactInquiries, getUnreadInquiryCount } from "@/server/queries/contact-inquiries";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewGetInTouch } from "@/lib/permissions";
import { EmptyState } from "@/components/crm/empty-state";
import { StatusBadge } from "@/components/crm/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { PaginationControls } from "@/components/crm/pagination-controls";
import { redirectToValidPageIfNeeded } from "@/lib/pagination";
import { INQUIRY_STATUS_META, INQUIRY_STATUS_ORDER, INQUIRY_SUBJECT_LABELS } from "@/lib/status-meta";
import type { InquirySource, InquiryStatus } from "@/generated/prisma/client";
import { cn } from "@/lib/utils";
import { messagePreview } from "@/lib/message-preview";
import { INQUIRY_SOURCE_META } from "@/lib/inquiry-source";
import { InquiryDeleteButton } from "@/components/get-in-touch/inquiry-delete-button";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The admin-only inbox for ONE inquiry system. Two sections render this same
 * component — "Business Flights — Get In Touch" (/get-in-touch) and "CRM
 * Inquiries" (/crm-inquiries) — each passing its own `source`. The source is
 * handed to every query, link and action below, so a section can only ever
 * list, open, change or delete ITS OWN rows.
 *
 * All admins see every incoming inquiry (companywide, not per-admin).
 * Database-paginated at 25/page; separate from Leads (never merged).
 */
export async function InquiryInbox({ source, searchParams }: { source: InquirySource; searchParams: SearchParams }) {
  const meta = INQUIRY_SOURCE_META[source];
  const sp = searchParams;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;

  // Unrecognised ?status= values are ignored (show everything) rather than
  // erroring — a stale or hand-edited URL is not a server error.
  const statusParam = typeof sp.status === "string" ? sp.status : undefined;
  const statusFilter = INQUIRY_STATUS_ORDER.find((st) => st === statusParam) as InquiryStatus | undefined;

  const current = await getCurrentAccount();
  if (!canViewGetInTouch(current?.role)) notFound();

  const [{ inquiries, total, pageCount, pageSize: effectivePageSize }, unreadCount] = await Promise.all([
    getContactInquiries({ companyId: current!.companyId, source, status: statusFilter, page, pageSize }),
    getUnreadInquiryCount(current!.companyId, source),
  ]);
  redirectToValidPageIfNeeded(sp, meta.basePath, page, pageCount);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{meta.label}</h1>
        <p className="text-sm text-muted-foreground">{meta.description}</p>
        <p className="text-sm text-muted-foreground">
          {total} inquir{total === 1 ? "y" : "ies"}
          {statusFilter ? ` (${INQUIRY_STATUS_META[statusFilter].label})` : ""} · {unreadCount} unread
        </p>
      </div>

      <nav aria-label="Filter inquiries by status" className="flex flex-wrap gap-1.5">
        {[undefined, ...INQUIRY_STATUS_ORDER].map((st) => {
          const active = st === statusFilter;
          return (
            <Link
              key={st ?? "all"}
              href={st ? `${meta.basePath}?status=${st}` : meta.basePath}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                active ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"
              )}
            >
              {st ? INQUIRY_STATUS_META[st].label : "All"}
            </Link>
          );
        })}
      </nav>

      {inquiries.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={statusFilter ? "No inquiries with this status" : "No inquiries yet"}
          description={`Submissions from this source appear here. ${meta.description}`}
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead>Received</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {inquiries.map((i) => {
                const statusMeta = INQUIRY_STATUS_META[i.status];
                return (
                  <TableRow key={i.id} className={i.readAt ? "hover:bg-muted/40" : "bg-info/5 hover:bg-info/10 font-medium"}>
                    <TableCell>{!i.readAt && <span className="block h-2 w-2 rounded-full bg-info" aria-label="Unread" />}</TableCell>
                    <TableCell className="text-sm">
                      <Link href={`${meta.basePath}/${i.id}`} className="hover:underline hover:text-primary">
                        {i.firstName} {i.lastName}
                      </Link>
                      {i.matchedContact && (
                        <Badge variant="outline" className="ml-2 text-[10px] font-normal">Matches {i.matchedContact.firstName} {i.matchedContact.lastName}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{i.email}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{i.phone ?? "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{INQUIRY_SUBJECT_LABELS[i.subject]}</TableCell>
                    <TableCell className="max-w-[18rem] truncate text-sm text-muted-foreground" title="Open the inquiry to read the full message">
                      {messagePreview(i.message)}
                    </TableCell>
                    <TableCell><StatusBadge label={statusMeta.label} tone={statusMeta.tone} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{i.assignedAdmin?.fullName ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDistanceToNow(i.createdAt, { addSuffix: true })}</TableCell>
                    <TableCell>
                      <InquiryDeleteButton inquiryId={i.id} name={`${i.firstName} ${i.lastName}`} source={source} />
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
