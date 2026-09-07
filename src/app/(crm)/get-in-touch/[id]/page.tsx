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

export const dynamic = "force-dynamic";

export default async function InquiryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const current = await getCurrentAccount();
  if (!canViewGetInTouch(current?.role)) notFound();

  const inquiry = await getContactInquiryDetail(id, current!.companyId);
  if (!inquiry) notFound();

  return (
    <div className="max-w-3xl space-y-4">
      <Link href="/get-in-touch" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to Get in Touch
      </Link>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{inquiry.firstName} {inquiry.lastName}</h1>
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
          {/* Item 16 (mobile pass) — bug fix: a long unbroken email address
              had no way to wrap within its grid cell, so it visually
              overflowed into the Phone column at narrow widths (text
              covering text). min-w-0 lets the cell actually shrink below
              its content's intrinsic width; break-words wraps the email
              instead of overflowing. */}
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
