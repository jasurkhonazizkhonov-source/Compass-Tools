import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

// Audit trail for Lead documents, written to the existing append-only AuditLog (entityType "Attachment"). Records WHO did WHAT to WHICH
// document / lead and the outcome — never the file's contents, its object key, a signed URL or a credential. The file NAME is also kept
// out: names are often personal data ("Passport - Jane Doe.pdf") and the attachment id already identifies the row for an investigation.

export type AttachmentAuditAction =
  | "ATTACHMENT_UPLOADED"
  | "ATTACHMENT_UPLOAD_REJECTED"
  | "ATTACHMENT_UPLOAD_FAILED"
  | "ATTACHMENT_OPENED"
  | "ATTACHMENT_DOWNLOADED"
  | "ATTACHMENT_DESCRIPTION_UPDATED"
  | "ATTACHMENT_DELETED"
  | "ATTACHMENT_ACCESS_DENIED"
  | "ATTACHMENT_STORAGE_ORPHANED";

export async function auditAttachment(params: {
  action: AttachmentAuditAction;
  actorId: string | null | undefined;
  attachmentId: string;
  leadId?: string | null;
  contactId?: string | null;
  companyId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: params.actorId ?? undefined,
        action: params.action,
        entityType: "Attachment",
        entityId: params.attachmentId,
        metadata: {
          leadId: params.leadId ?? null,
          contactId: params.contactId ?? null,
          companyId: params.companyId ?? null,
          ...params.metadata,
        } as Prisma.InputJsonValue,
      },
    });
  } catch {
    // An audit write failing must not turn a completed, authorised operation into an error (nor leak why); it is retried by the caller's
    // own next action. The storage and authorisation outcome has already been decided.
    console.error("[attachments] audit write failed");
  }
}
