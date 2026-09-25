import { notFound } from "next/navigation";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft } from "lucide-react";
import { getContactInquiryDetail } from "@/server/queries/contact-inquiries";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewGetInTouch } from "@/lib/permissions";
import { InquiryDetailPanel } from "@/components/get-in-touch/inquiry-detail-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { INQUIRY_SUBJECT_LABELS } from "@/lib/status-meta";
import { INQUIRY_SOURCE_META } from "@/lib/inquiry-source";
import type { InquirySource } from "@/generated/prisma/client";

/**
 * One inquiry's detail page for ONE inquiry system. An id that belongs to the
 * OTHER system is "not found" here (the query is scoped by source), so
 * pasting a CRM inquiry's id under /get-in-touch — or the reverse — is a 404,
 * never a cross-system view or edit.
 */
export async function InquiryDetailView({ source, id }: { source: InquirySource; id: string }) {
  const meta = INQUIRY_SOURCE_META[source];
  const current = await getCurrentAccount();
  if (!canViewGetInTouch(current?.role)) notFound();

  const inquiry = await getContactInquiryDetail(id, current!.companyId, source);
  if (!inquiry) notFound();

  return (
    <div className="max-w-3xl space-y-4">
      <Link href={meta.basePath} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to {meta.label}
      </Link>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{inquiry.firstName} {inquiry.lastName}</h1>
          <Badge variant="secondary" className="text-[10px] font-normal">{meta.label}</Badge>
          {inquiry.matchedContact && (
            <Link href={`/contacts/${inquiry.matchedContact.id}`}>
              <Badge variant="outline" className="text-[10px] font-normal">
                Matches existing contact{inquiry.matchedContact.owner ? ` · ${inquiry.matchedContact.owner.fullName}` : ""}
              </Badge>
            </Link>
          )}
          {/* Item 10 — reference/link only, never an auto-conversion or
              merge. Reuses the existing contact match (matchedContactId, set
              once at submission time) — just surfaces whether that same
              contact also has a Lead on file, read-only. */}
          {inquiry.matchedContact?.leads?.[0] && (
            <Link href={`/leads/${inquiry.matchedContact.leads[0].id}`}>
              <Badge variant="outline" className="text-[10px] font-normal">
                Existing Lead Found
              </Badge>
            </Link>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {INQUIRY_SUBJECT_LABELS[inquiry.subject]} · Received {format(inquiry.createdAt, "MMM d, yyyy 'at' h:mm a")}
        </p>
      </div>

      <Card className="shadow-none">
        <CardHeader><CardTitle className="text-sm font-medium">Submission</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {/* Item 16 (mobile pass) — a long unbroken email address had no way
              to wrap within its grid cell, so it visually overflowed into the
              Phone column at narrow widths. min-w-0 lets the cell shrink;
              break-words wraps the email instead of overflowing. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Email</p>
              <p className="break-words">{inquiry.email}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Phone</p>
              <p>{inquiry.phone ?? "—"}</p>
            </div>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Message</p>
            <p className="whitespace-pre-wrap mt-1">{inquiry.message}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardContent className="pt-5">
          <InquiryDetailPanel
            inquiryId={inquiry.id}
            source={source}
            status={inquiry.status}
            readAt={inquiry.readAt}
            email={inquiry.email}
            phone={inquiry.phone}
            notes={inquiry.notes}
            contactName={`${inquiry.firstName} ${inquiry.lastName}`}
          />
        </CardContent>
      </Card>
    </div>
  );
}
