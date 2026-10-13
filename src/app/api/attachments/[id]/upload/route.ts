import { NextResponse, type NextRequest } from "next/server";
import { getCurrentAccount } from "@/lib/dev-session";
import { canUploadLeadAttachments } from "@/lib/permissions";
import { leadVisibilityWhere } from "@/server/visibility";
import { prisma } from "@/lib/prisma";
import { allowedTypeForMime, maxFileSizeBytes } from "@/lib/attachments/policy";
import { matchesSignature } from "@/server/attachments/signature";
import { auditAttachment } from "@/server/attachments/audit";
import { hasRoomFor, storeUpload } from "@/server/storage/local";

// Receives the BYTES of a Lead document: the browser PUTs the file here (same origin, with the session cookie) after
// requestLeadAttachmentUpload created the PENDING record. This replaces the browser -> R2 presigned upload.
//
//   PUT /api/attachments/{attachmentId}/upload      body = the raw file (no multipart)
//
// What is trusted: NOTHING the browser sends about the file. The expected size, type and name come from the PENDING row the server
// created; the request's Content-Type and any name are ignored. What is checked, in order:
//   1. a signed-in ACTIVE account that may upload documents, and CSRF (a cross-site Origin is refused; the cookie is SameSite=Lax too)
//   2. the pending attachment is the caller's OWN, in the caller's company, on a lead the caller can see (leadVisibilityWhere) - anything
//      else is the same plain 404, so nothing reveals whether another lead's / company's upload exists
//   3. the declared Content-Length equals the authorised size BEFORE a single body byte is read
//   4. there is disk room (reserve kept free for the database)
//   5. while streaming: never more than the authorised size (the request is cut off at the first excess byte), exactly that size at the
//      end, and the first bytes match the file format its extension claims (PDF / JPEG / PNG / WebP / Office / text signatures)
//   6. only then is the file published, atomically and exclusively (src/server/storage/local.ts). The attachment stays PENDING until
//      completeLeadAttachmentUpload re-verifies it - nothing is visible to anyone yet.
// A definite rejection (wrong size, wrong content) also removes the pending record. Every message is generic: no path, no key, no
// provider detail ever reaches the browser.
//
// This route must stay OUTSIDE src/proxy.ts's matcher: Next buffers request bodies of routes the proxy runs on (default cap 10 MB),
// which would defeat streaming. /api/* is not matched; a test guards it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (status: number, error: string) => NextResponse.json({ error }, { status, headers: NO_STORE });
const NOT_FOUND = () => json(404, "Not found");
const MISMATCH = "The uploaded file didn't match what was selected. Please try again.";
const UNAVAILABLE = "File storage is unavailable right now. Please try again in a moment.";
const FULL = "File storage is almost full, so new files can't be added right now. Please ask an administrator.";

/** A request that names another site as its origin is not our own page uploading a file. */
function crossSite(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false; // same-origin XHR from older engines may omit it; SameSite=Lax cookies still protect
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return true;
  }
  const ours = [request.headers.get("host"), request.headers.get("x-forwarded-host"), request.nextUrl.host].filter((h): h is string => !!h).map((h) => h.split(",")[0].trim().toLowerCase());
  return !ours.includes(host.toLowerCase());
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE") return json(401, "Sign in required");
  if (!canUploadLeadAttachments(actor.role) || typeof id !== "string" || id.length === 0 || id.length > 80) return NOT_FOUND();
  if (crossSite(request)) return json(403, "Forbidden");

  // Authorisation is the query: the caller's own PENDING local upload, same company, on a lead this viewer can see.
  const row = await prisma.attachment.findFirst({
    where: {
      id,
      uploadedById: actor.id,
      companyId: actor.companyId,
      status: "PENDING",
      storageProvider: "LOCAL",
      storageKey: { not: null },
      lead: { is: leadVisibilityWhere({ id: actor.id, role: actor.role, companyId: actor.companyId }) },
    },
    select: { id: true, storageKey: true, fileType: true, fileSize: true, leadId: true, contactId: true },
  });
  if (!row || !row.storageKey || !row.leadId) {
    await auditAttachment({ action: "ATTACHMENT_ACCESS_DENIED", actorId: actor.id, attachmentId: id, metadata: { attempted: "UPLOAD_BYTES", reason: "NOT_FOUND_OR_NOT_ACCESSIBLE" } });
    return NOT_FOUND();
  }

  // Definite rejections remove the pending record (nothing was published); the browser's own abandon call is then a harmless no-op.
  const reject = async (reason: string, status: number, message: string) => {
    await prisma.attachment.deleteMany({ where: { id: row.id, status: "PENDING" } });
    await auditAttachment({ action: "ATTACHMENT_UPLOAD_REJECTED", actorId: actor.id, attachmentId: row.id, leadId: row.leadId, contactId: row.contactId, companyId: actor.companyId, metadata: { reason } });
    return json(status, message);
  };

  const type = allowedTypeForMime(row.fileType);
  if (!type || row.fileSize == null || row.fileSize <= 0) return reject("INVALID_RECORD", 400, MISMATCH);
  if (row.fileSize > maxFileSizeBytes()) return reject("SIZE_LIMIT", 413, MISMATCH);

  // The declared length must be exactly the authorised size - checked before reading any of the body.
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) !== row.fileSize)) return reject("SIZE_MISMATCH", declared && Number(declared) > row.fileSize ? 413 : 400, MISMATCH);
  if (!request.body) return reject("EMPTY_BODY", 400, MISMATCH);

  if (!(await hasRoomFor(row.fileSize))) return json(507, FULL);

  const result = await storeUpload(row.storageKey, request.body, {
    expectedSize: row.fileSize,
    acceptHead: (head) => matchesSignature(type.signature, head),
    signal: request.signal,
  });

  if (result.ok) return NextResponse.json({ ok: true }, { headers: NO_STORE });
  switch (result.reason) {
    case "TOO_LARGE":
      return reject("SIZE_EXCEEDED", 413, MISMATCH);
    case "SIZE_MISMATCH":
      return reject("SIZE_MISMATCH", 400, MISMATCH);
    case "SIGNATURE_MISMATCH":
      return reject("SIGNATURE_MISMATCH", 422, "This file's contents don't match its file type, so it was not saved.");
    case "EXISTS":
      // This attachment already has its file (a duplicate or racing request): nothing is touched, the first upload stands.
      return json(409, "This upload was already received.");
    case "NO_SPACE":
      return json(507, FULL);
    default:
      return json(503, UNAVAILABLE);
  }
}
