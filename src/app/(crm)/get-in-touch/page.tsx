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
import type { InquiryStatus } from "@/generated/prisma/client";
import { cn } from "@/lib/utils";
import { messagePreview } from "@/lib/message-preview";
import { InquiryDeleteButton } from "@/components/get-in-touch/inquiry-delete-button";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Part 9 — admin-only public-website inquiry inbox ("CRM Inquiries" in the
 * sidebar; the route keeps its original /get-in-touch path, which is also
 * the name of the public website's contact form that feeds it). All admins see every
 * incoming inquiry (companywide, not per-admin) — matches the spec's "all
 * admins see incoming inquiries." Pass 7 — database-paginated at 25/page;
 * still its own separate model/query from Leads (never merged).
 */
export default async function GetInTouchPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;

  // Unrecognised ?status= values are ignored (show everything) rather than
  // erroring — a stale or hand-edited URL is not a server error.
  const statusParam = typeof sp.status === "string" ? sp.status : undefined;
  const statusFilter = INQUIRY_STATUS_ORDER.find((st) => st === statusParam) as InquiryStatus | undefined;

  const current = await getCurrentAccount();
  if (!canViewGetInTouch(current?.role)) notFound();

  const [{ inquiries, total, pageCount, pageSize: effectivePageSize }, unreadCount] = await Promise.all([
    getContactInquiries({ companyId: current!.companyId, status: statusFilter, page, pageSize }),
    getUnreadInquiryCount(current!.companyId),
  ]);
  redirectToValidPageIfNeeded(sp, "/get-in-touch", page, pageCount);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">CRM Inquiries</h1>
        <p className="text-sm text-muted-foreground">
          Messages sent through the website&apos;s Get in Touch form · {total} inquir{total === 1 ? "y" : "ies"}
          {statusFilter ? ` (${INQUIRY_STATUS_META[statusFilter].label})` : ""} · {unreadCount} unread
        </p>
      </div>

      <nav aria-label="Filter inquiries by status" className="flex flex-wrap gap-1.5">
        {[undefined, ...INQUIRY_STATUS_ORDER].map((st) => {
          const active = st === statusFilter;
          return (
            <Link
              key={st ?? "all"}
              href={st ? `/get-in-touch?status=${st}` : "/get-in-touch"}
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
        <EmptyState icon={Inbox} title={statusFilter ? "No inquiries with this status" : "No inquiries yet"} description="Submissions from the public website's Get in Touch form appear here." />
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
                const meta = INQUIRY_STATUS_META[i.status];
                return (
                  <TableRow key={i.id} className={i.readAt ? "hover:bg-muted/40" : "bg-info/5 hover:bg-info/10 font-medium"}>
                    <TableCell>{!i.readAt && <span className="block h-2 w-2 rounded-full bg-info" aria-label="Unread" />}</TableCell>
                    <TableCell className="text-sm">
                      <Link href={`/get-in-touch/${i.id}`} className="hover:underline hover:text-primary">
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
                    <TableCell><StatusBadge label={meta.label} tone={meta.tone} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{i.assignedAdmin?.fullName ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDistanceToNow(i.createdAt, { addSuffix: true })}</TableCell>
                    <TableCell>
                      <InquiryDeleteButton inquiryId={i.id} name={`${i.firstName} ${i.lastName}`} />
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
