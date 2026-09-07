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
import { INQUIRY_STATUS_META, INQUIRY_SUBJECT_LABELS } from "@/lib/status-meta";
import { InquiryDeleteButton } from "@/components/get-in-touch/inquiry-delete-button";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Part 9 — admin-only public-website inquiry inbox. All admins see every
 * incoming inquiry (companywide, not per-admin) — matches the spec's "all
 * admins see incoming inquiries." Pass 7 — database-paginated at 25/page;
 * still its own separate model/query from Leads (never merged).
 */
export default async function GetInTouchPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const page = sp.page ? Number(sp.page) : 1;
  const pageSize = typeof sp.pageSize === "string" ? Number(sp.pageSize) : undefined;

  const current = await getCurrentAccount();
  if (!canViewGetInTouch(current?.role)) notFound();

  const [{ inquiries, total, pageCount, pageSize: effectivePageSize }, unreadCount] = await Promise.all([
    getContactInquiries({ companyId: current!.companyId, page, pageSize }),
    getUnreadInquiryCount(current!.companyId),
  ]);
  redirectToValidPageIfNeeded(sp, "/get-in-touch", page, pageCount);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Get in Touch</h1>
        <p className="text-sm text-muted-foreground">
          {total} inquir{total === 1 ? "y" : "ies"} · {unreadCount} unread
        </p>
      </div>

      {inquiries.length === 0 ? (
        <EmptyState icon={Inbox} title="No inquiries yet" description="Submissions from the public website's Get in Touch form appear here." />
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
