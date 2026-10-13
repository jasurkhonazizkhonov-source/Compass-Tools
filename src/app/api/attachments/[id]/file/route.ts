import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewLeads } from "@/lib/permissions";
import { checkAccountRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { visibleAttachmentWhere } from "@/server/queries/lead-attachments";
import { prisma } from "@/lib/prisma";
import { localStorage } from "@/server/storage/local";
import { legacyR2, isLegacyR2Configured } from "@/server/storage/legacy-r2";
import { auditAttachment } from "@/server/attachments/audit";
import { allowedTypeForMime, contentDisposition } from "@/lib/attachments/policy";

// Open / download a Lead document. The browser never holds a permanent URL and nothing is served from a public directory: this route
// authorises the request FIRST and only then produces the bytes.
//
//   GET /api/attachments/{attachmentId}/file            → opens PDFs / images in the tab, downloads everything else
//   GET /api/attachments/{attachmentId}/file?download=1 → always downloads
//
//   LOCAL files (every new upload)  streamed from the VPS disk by this route, with the type and disposition forced by the server.
//   R2 files (uploaded before the move to local storage)  answered with a redirect to a signed link that expires in 60 seconds and
//                                   forces the same type and disposition - see src/server/storage/legacy-r2.ts.
//
// "Does not exist", "belongs to another lead" and "belongs to another company" are all the same 404.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
const UNAVAILABLE = () => NextResponse.json({ error: "File storage is unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });

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
    select: { id: true, storageKey: true, storageProvider: true, fileName: true, fileType: true, leadId: true, contactId: true },
  });
  if (!row || !row.storageKey) {
    await auditAttachment({ action: "ATTACHMENT_ACCESS_DENIED", actorId: actor.id, attachmentId: id, metadata: { attempted: "OPEN", reason: "NOT_FOUND_OR_NOT_ACCESSIBLE" } });
    return NOT_FOUND();
  }

  const type = allowedTypeForMime(row.fileType);
  if (!type) return NOT_FOUND();
  const forceDownload = request.nextUrl.searchParams.get("download") === "1";
  const inline = type.inline && !forceDownload;
  const disposition = contentDisposition(inline ? "inline" : "attachment", row.fileName);
  const audit = () =>
    auditAttachment({
      action: inline ? "ATTACHMENT_OPENED" : "ATTACHMENT_DOWNLOADED",
      actorId: actor.id,
      attachmentId: row.id,
      leadId: row.leadId,
      contactId: row.contactId,
      companyId: actor.companyId,
    });

  if (row.storageProvider === "R2") {
    if (!isLegacyR2Configured()) return UNAVAILABLE();
    let url: string;
    try {
      url = await legacyR2.presignDownload(row.storageKey, { contentType: type.mime, contentDisposition: disposition });
    } catch {
      return UNAVAILABLE();
    }
    await audit();
    return new NextResponse(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }

  // LOCAL: stream from disk. The key comes from the row (never from the request); the local module refuses anything but its own shape.
  let file: Awaited<ReturnType<typeof localStorage.openRead>>;
  try {
    file = await localStorage.openRead(row.storageKey);
  } catch {
    return UNAVAILABLE();
  }
  // The row says READY but the bytes are gone (disk restored without the files, manual deletion): a plain 404, never a path or a 500.
  if (!file) return NOT_FOUND();

  await audit();
  return new NextResponse(Readable.toWeb(file.stream) as ReadableStream, {
    status: 200,
    headers: {
      // The type is the server's own choice for the validated extension, never the browser's claim, and nosniff stops a browser second-
      // guessing it. An uploaded file is therefore never interpreted as HTML / script in this site's origin.
      "Content-Type": type.mime,
      "Content-Disposition": disposition,
      "Content-Length": String(file.size),
      "X-Content-Type-Options": "nosniff",
      // Nothing about a document may be stored by a browser cache, proxy or CDN; and no other origin may embed it.
      "Cache-Control": "private, no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      // Whatever the file contains, it may not load anything or run script (images need none). A PDF gets only the framing rule: browsers'
      // built-in PDF viewers load their own resources and a restrictive default-src can stop them rendering it; a PDF is never parsed as
      // HTML (forced type + nosniff), so nothing is lost.
      "Content-Security-Policy": type.mime === "application/pdf" ? "frame-ancestors 'none'" : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
