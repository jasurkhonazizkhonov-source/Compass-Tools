import { NextResponse, type NextRequest } from "next/server";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewLeads } from "@/lib/permissions";
import { checkAccountRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { visibleAttachmentWhere } from "@/server/queries/lead-attachments";
import { prisma } from "@/lib/prisma";
import { objectStorage, isStorageConfigured } from "@/server/storage/r2";
import { auditAttachment } from "@/server/attachments/audit";
import { allowedTypeForMime, contentDisposition } from "@/lib/attachments/policy";

// Open / download a Lead document. The browser never holds a permanent URL: this route authorises the request FIRST, then answers with a
// redirect to a presigned URL that expires in 60 seconds and forces the served type and disposition.
//
//   GET /api/attachments/{attachmentId}/file            → opens PDFs / images in the tab, downloads everything else
//   GET /api/attachments/{attachmentId}/file?download=1 → always downloads
//
// "Does not exist", "belongs to another lead" and "belongs to another company" are all the same 404.
export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE") return NextResponse.json({ error: "Sign in required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (!canViewLeads(actor.role) || typeof id !== "string" || id.length === 0 || id.length > 80) return NOT_FOUND();

  const limited = await checkAccountRateLimit(actor.id, "attachment-download", RATE_LIMITS.ATTACHMENT_DOWNLOAD);
  if (!limited.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds), "Cache-Control": "no-store" } });
  }

  // Authorisation is the query: READY, same company, and the attachment's OWN lead visible to this viewer.
  const row = await prisma.attachment.findFirst({
    where: { ...visibleAttachmentWhere({ id: actor.id, role: actor.role, companyId: actor.companyId }), id },
    select: { id: true, storageKey: true, fileName: true, fileType: true, leadId: true, contactId: true },
  });
  if (!row || !row.storageKey) {
    await auditAttachment({ action: "ATTACHMENT_ACCESS_DENIED", actorId: actor.id, attachmentId: id, metadata: { attempted: "OPEN", reason: "NOT_FOUND_OR_NOT_ACCESSIBLE" } });
    return NOT_FOUND();
  }
  if (!isStorageConfigured()) return NextResponse.json({ error: "File storage is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });

  const type = allowedTypeForMime(row.fileType);
  if (!type) return NOT_FOUND();
  const forceDownload = request.nextUrl.searchParams.get("download") === "1";
  const inline = type.inline && !forceDownload;

  let url: string;
  try {
    url = await objectStorage.presignDownload(row.storageKey, { contentType: type.mime, contentDisposition: contentDisposition(inline ? "inline" : "attachment", row.fileName) });
  } catch {
    return NextResponse.json({ error: "File storage is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  await auditAttachment({
    action: inline ? "ATTACHMENT_OPENED" : "ATTACHMENT_DOWNLOADED",
    actorId: actor.id,
    attachmentId: row.id,
    leadId: row.leadId,
    contactId: row.contactId,
    companyId: actor.companyId,
  });
  return new NextResponse(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
