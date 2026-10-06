"use server";

import { randomBytes, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canUploadLeadAttachments, canManageLeadAttachments } from "@/lib/permissions";
import { leadVisibilityWhere } from "@/server/visibility";
import { checkAccountRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { logActivity } from "@/server/activity-log";
import { objectStorage, isStorageConfigured } from "@/server/storage/r2";
import { matchesSignature, SIGNATURE_PROBE_BYTES } from "@/server/attachments/signature";
import { auditAttachment } from "@/server/attachments/audit";
import { safeActionMessage } from "@/lib/safe-action-message";
import {
  MAX_ATTACHMENTS_PER_LEAD,
  MAX_DESCRIPTION_LENGTH,
  allowedTypeForMime,
  buildStorageKey,
  maxFileSizeBytes,
  sanitizeDescription,
  validateFile,
} from "@/lib/attachments/policy";

// Lead documents — server actions. Every export is a callable RPC, so each one re-derives authorisation itself and never trusts the
// page that rendered the button:
//
//     current account (ACTIVE)  →  role may do this  →  the LEAD is visible to that account  (leadVisibilityWhere: company + role + team)
//                               →  the attachment belongs to THAT lead and THAT company  →  only then storage is touched.
//
// The Lead (and company) always come from the database relationship, never from a value the browser supplies beside the attachment id.
// A request for something that does not exist and one for something the caller may not see produce the SAME generic answer, so nothing
// reveals whether another lead's / company's document exists.

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const DENIED = "You can't access this file.";
const UPLOAD_DENIED = "You can't add files to this lead.";
const STORAGE_DOWN = "File storage is unavailable right now. Please try again in a moment.";
const RETRY = "Something went wrong. Please try again.";

type Actor = NonNullable<Awaited<ReturnType<typeof getCurrentAccount>>>;

async function activeActor(): Promise<Actor | null> {
  const actor = await getCurrentAccount();
  return actor && actor.status === "ACTIVE" ? actor : null;
}

const viewerOf = (a: Actor) => ({ id: a.id, role: a.role, companyId: a.companyId });

async function rateLimited(actor: Actor, endpoint: string, config: Parameters<typeof checkAccountRateLimit>[2]): Promise<boolean> {
  return !(await checkAccountRateLimit(actor.id, endpoint, config)).allowed;
}

// ── 1. request an upload ────────────────────────────────────────────────────────────────────────────────────────────────────
const requestSchema = z.object({
  leadId: z.string().min(1).max(64),
  fileName: z.string().min(1).max(400),
  contentType: z.string().max(200).optional().default(""),
  size: z.number().int().positive(),
  description: z.string().max(5000).optional().nullable(),
});

/**
 * Step 1 of an upload. Validates the file (type, size, name) and the caller's access to the lead, records a PENDING attachment with an
 * opaque server-generated key, and returns a short-lived presigned URL for exactly that object. Nothing is visible to anyone yet.
 */
export async function requestLeadAttachmentUpload(
  input: unknown,
): Promise<ActionResult<{ attachmentId: string; uploadUrl: string; headers: Record<string, string> }>> {
  try {
    const actor = await activeActor();
    const parsed = requestSchema.safeParse(input);
    if (!actor || !canUploadLeadAttachments(actor.role) || !parsed.success) return { ok: false, error: UPLOAD_DENIED };
    const { leadId, fileName: rawName, contentType, size, description } = parsed.data;

    if (await rateLimited(actor, "attachment-upload", RATE_LIMITS.ATTACHMENT_UPLOAD)) return { ok: false, error: "Too many uploads. Please wait a few minutes and try again." };

    // The lead is looked up THROUGH the viewer's visibility: another company's / another agent's lead is simply not found.
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(viewerOf(actor)) },
      select: { id: true, contactId: true, contact: { select: { companyId: true } }, _count: { select: { attachments: true } } },
    });
    if (!lead || lead.contact.companyId !== actor.companyId) {
      await auditAttachment({ action: "ATTACHMENT_ACCESS_DENIED", actorId: actor.id, attachmentId: "n/a", leadId, metadata: { attempted: "UPLOAD", reason: "LEAD_NOT_ACCESSIBLE" } });
      return { ok: false, error: UPLOAD_DENIED };
    }

    const checked = validateFile({ fileName: rawName, contentType, size }, maxFileSizeBytes());
    if (!checked.ok) {
      await auditAttachment({ action: "ATTACHMENT_UPLOAD_REJECTED", actorId: actor.id, attachmentId: "n/a", leadId: lead.id, companyId: actor.companyId, metadata: { reason: "VALIDATION", size } });
      return { ok: false, error: checked.error };
    }
    if (lead._count.attachments >= MAX_ATTACHMENTS_PER_LEAD) return { ok: false, error: "This lead has reached the maximum number of files." };
    if (!isStorageConfigured()) return { ok: false, error: "File uploads are not set up yet. Ask an administrator to configure file storage." };

    const attachmentId = randomUUID();
    const storageKey = buildStorageKey({ companyId: lead.contact.companyId, leadId: lead.id, attachmentId, random: randomBytes(16).toString("hex") });
    await prisma.attachment.create({
      data: {
        id: attachmentId,
        leadId: lead.id,
        contactId: lead.contactId,
        companyId: lead.contact.companyId,
        fileName: checked.fileName,
        fileType: checked.type.mime,
        fileSize: size,
        description: sanitizeDescription(description),
        uploadedById: actor.id,
        storageKey,
        status: "PENDING",
      },
    });

    try {
      const { url } = await objectStorage.presignUpload(storageKey, checked.type.mime, size);
      return { ok: true, attachmentId, uploadUrl: url, headers: { "Content-Type": checked.type.mime } };
    } catch {
      await prisma.attachment.deleteMany({ where: { id: attachmentId, status: "PENDING" } });
      return { ok: false, error: STORAGE_DOWN };
    }
  } catch (err) {
    return { ok: false, error: safeActionMessage(err, RETRY) };
  }
}

// ── 2. complete (verify) an upload ──────────────────────────────────────────────────────────────────────────────────────────
async function discardPending(id: string, storageKey: string | null) {
  if (storageKey) await objectStorage.remove(storageKey).catch(() => {});
  await prisma.attachment.deleteMany({ where: { id, status: "PENDING" } });
}

/**
 * Step 2. Only the uploader can complete their own pending upload. The stored object is checked (it exists, its size is exactly what was
 * authorised and within the limit, and its first bytes match what the extension claims) before the attachment becomes READY; anything
 * that fails is removed from storage and from the database.
 */
export async function completeLeadAttachmentUpload(attachmentId: unknown): Promise<ActionResult<{ attachmentId: string }>> {
  try {
    const actor = await activeActor();
    if (!actor || typeof attachmentId !== "string" || attachmentId.length > 80 || !canUploadLeadAttachments(actor.role)) return { ok: false, error: UPLOAD_DENIED };

    const row = await prisma.attachment.findFirst({
      where: { id: attachmentId, uploadedById: actor.id, companyId: actor.companyId, storageKey: { not: null }, lead: { is: leadVisibilityWhere(viewerOf(actor)) } },
      select: { id: true, status: true, storageKey: true, fileName: true, fileType: true, fileSize: true, leadId: true, contactId: true },
    });
    if (!row || !row.storageKey || !row.leadId) {
      await auditAttachment({ action: "ATTACHMENT_ACCESS_DENIED", actorId: actor.id, attachmentId, metadata: { attempted: "COMPLETE_UPLOAD", reason: "NOT_FOUND_OR_NOT_ACCESSIBLE" } });
      return { ok: false, error: UPLOAD_DENIED };
    }
    if (row.status === "READY") return { ok: true, attachmentId: row.id }; // idempotent

    const type = allowedTypeForMime(row.fileType);
    const reject = async (reason: string, message: string) => {
      await discardPending(row.id, row.storageKey);
      await auditAttachment({ action: "ATTACHMENT_UPLOAD_REJECTED", actorId: actor.id, attachmentId: row.id, leadId: row.leadId, contactId: row.contactId, companyId: actor.companyId, metadata: { reason } });
      return { ok: false as const, error: message };
    };
    if (!type || row.fileSize == null) return await reject("INVALID_RECORD", RETRY);

    let stored: { size: number } | null;
    let head: Uint8Array | null;
    try {
      stored = await objectStorage.head(row.storageKey);
      head = stored ? await objectStorage.readHead(row.storageKey, SIGNATURE_PROBE_BYTES) : null;
    } catch {
      // Storage unreachable: leave the row PENDING so the user can retry completing; the sweep removes it if they never do.
      return { ok: false, error: STORAGE_DOWN };
    }
    if (!stored || !head) return await reject("OBJECT_MISSING", "The upload didn't finish. Please try again.");
    if (stored.size !== row.fileSize || stored.size > maxFileSizeBytes()) return await reject("SIZE_MISMATCH", "The uploaded file didn't match what was selected. Please try again.");
    if (!matchesSignature(type.signature, head)) return await reject("SIGNATURE_MISMATCH", "This file's contents don't match its file type, so it was not saved.");

    const done = await prisma.attachment.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "READY" } });
    if (done.count === 1) {
      await auditAttachment({ action: "ATTACHMENT_UPLOADED", actorId: actor.id, attachmentId: row.id, leadId: row.leadId, contactId: row.contactId, companyId: actor.companyId, metadata: { size: stored.size, mime: row.fileType } });
      await logActivity({ leadId: row.leadId, contactId: row.contactId ?? undefined, actorId: actor.id, type: "DOCUMENT_ADDED", description: `Uploaded a document: ${row.fileName}` }).catch(() => {});
    }
    revalidatePath(`/leads/${row.leadId}`);
    if (row.contactId) revalidatePath(`/contacts/${row.contactId}`);
    return { ok: true, attachmentId: row.id };
  } catch (err) {
    return { ok: false, error: safeActionMessage(err, RETRY) };
  }
}

/** The browser's PUT failed or was cancelled: drop the caller's own pending upload. */
export async function abandonLeadAttachmentUpload(attachmentId: unknown): Promise<ActionResult> {
  try {
    const actor = await activeActor();
    if (!actor || typeof attachmentId !== "string" || attachmentId.length > 80) return { ok: false, error: DENIED };
    const row = await prisma.attachment.findFirst({
      where: { id: attachmentId, uploadedById: actor.id, companyId: actor.companyId, status: "PENDING", lead: { is: leadVisibilityWhere(viewerOf(actor)) } },
      select: { id: true, storageKey: true },
    });
    if (row) await discardPending(row.id, row.storageKey);
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

// ── 3. edit the description (Admin / Manager) ───────────────────────────────────────────────────────────────────────────────
async function findManageableAttachment(actor: Actor, attachmentId: string) {
  return prisma.attachment.findFirst({
    where: { id: attachmentId, status: "READY", companyId: actor.companyId, storageKey: { not: null }, lead: { is: leadVisibilityWhere(viewerOf(actor)) } },
    select: { id: true, storageKey: true, description: true, leadId: true, contactId: true },
  });
}

export async function updateLeadAttachmentDescription(attachmentId: unknown, description: unknown): Promise<ActionResult<{ description: string | null }>> {
  try {
    const actor = await activeActor();
    if (!actor || typeof attachmentId !== "string" || attachmentId.length > 80) return { ok: false, error: DENIED };
    if (!canManageLeadAttachments(actor.role)) {
      await auditAttachment({ action: "ATTACHMENT_ACCESS_DENIED", actorId: actor.id, attachmentId, metadata: { attempted: "EDIT_DESCRIPTION", reason: "MISSING_PERMISSION" } });
      return { ok: false, error: DENIED };
    }
    if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH * 4) return { ok: false, error: `The description can be at most ${MAX_DESCRIPTION_LENGTH} characters.` };
    if (await rateLimited(actor, "attachment-mutation", RATE_LIMITS.ATTACHMENT_MUTATION)) return { ok: false, error: "Too many changes. Please wait a few minutes and try again." };

    const row = await findManageableAttachment(actor, attachmentId);
    if (!row || !row.leadId) {
      await auditAttachment({ action: "ATTACHMENT_ACCESS_DENIED", actorId: actor.id, attachmentId, metadata: { attempted: "EDIT_DESCRIPTION", reason: "NOT_FOUND_OR_NOT_ACCESSIBLE" } });
      return { ok: false, error: DENIED };
    }
    const next = sanitizeDescription(description);
    // Metadata only: the stored file is not touched.
    await prisma.attachment.update({ where: { id: row.id }, data: { description: next } });
    await auditAttachment({ action: "ATTACHMENT_DESCRIPTION_UPDATED", actorId: actor.id, attachmentId: row.id, leadId: row.leadId, contactId: row.contactId, companyId: actor.companyId, metadata: { previousLength: row.description?.length ?? 0, newLength: next?.length ?? 0 } });
    revalidatePath(`/leads/${row.leadId}`);
    if (row.contactId) revalidatePath(`/contacts/${row.contactId}`);
    return { ok: true, description: next };
  } catch (err) {
    return { ok: false, error: safeActionMessage(err, RETRY) };
  }
}

// ── 4. delete (Admin / Manager) ─────────────────────────────────────────────────────────────────────────────────────────────
export async function deleteLeadAttachment(attachmentId: unknown): Promise<ActionResult> {
  try {
    const actor = await activeActor();
    if (!actor || typeof attachmentId !== "string" || attachmentId.length > 80) return { ok: false, error: DENIED };
    if (!canManageLeadAttachments(actor.role)) {
      await auditAttachment({ action: "ATTACHMENT_ACCESS_DENIED", actorId: actor.id, attachmentId, metadata: { attempted: "DELETE", reason: "MISSING_PERMISSION" } });
      return { ok: false, error: DENIED };
    }
    if (await rateLimited(actor, "attachment-mutation", RATE_LIMITS.ATTACHMENT_MUTATION)) return { ok: false, error: "Too many changes. Please wait a few minutes and try again." };

    const row = await findManageableAttachment(actor, attachmentId);
    if (!row || !row.leadId || !row.storageKey) {
      await auditAttachment({ action: "ATTACHMENT_ACCESS_DENIED", actorId: actor.id, attachmentId, metadata: { attempted: "DELETE", reason: "NOT_FOUND_OR_NOT_ACCESSIBLE" } });
      return { ok: false, error: DENIED };
    }

    // Object first, row second. If the object delete fails the row stays (nothing is lost, the user can retry); if the row delete fails
    // after the object is gone, a retry succeeds because deleting a missing object is a no-op.
    try {
      await objectStorage.remove(row.storageKey);
    } catch {
      return { ok: false, error: "The file couldn't be deleted right now. Please try again." };
    }
    await prisma.attachment.deleteMany({ where: { id: row.id, companyId: actor.companyId } });
    await auditAttachment({ action: "ATTACHMENT_DELETED", actorId: actor.id, attachmentId: row.id, leadId: row.leadId, contactId: row.contactId, companyId: actor.companyId });
    revalidatePath(`/leads/${row.leadId}`);
    if (row.contactId) revalidatePath(`/contacts/${row.contactId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: safeActionMessage(err, RETRY) };
  }
}
