import { prisma } from "@/lib/prisma";
import { PENDING_UPLOAD_TTL_MS } from "@/lib/attachments/policy";
import { objectStorage, isStorageConfigured } from "@/server/storage/r2";
import { auditAttachment } from "@/server/attachments/audit";

// Keeping Postgres and R2 consistent. The two cannot share a transaction, so every path is ordered so that the failure mode is "an
// extra object" (invisible, collectable) rather than "a visible file with no bytes":
//   • upload  — row PENDING first; READY only after the stored object is verified; stale PENDING rows are swept here.
//   • delete  — the object is removed first, then the row; a failure between the two leaves a row the user can simply delete again
//               (deleting an already-missing object succeeds).
//   • lead / contact deletion (database cascade removes the rows) — the object keys are collected BEFORE the delete and purged after it;
//               a purge that fails is recorded in the audit log with the keys so it can be reconciled.

/** Object keys of every stored file of these leads (read before a cascade delete removes the rows). */
export async function storageKeysForLeads(where: { leadId?: string; contactId?: string }): Promise<string[]> {
  const rows = await prisma.attachment.findMany({
    where: { storageKey: { not: null }, ...(where.leadId ? { leadId: where.leadId } : {}), ...(where.contactId ? { lead: { is: { contactId: where.contactId } } } : {}) },
    select: { storageKey: true },
  });
  return rows.map((r) => r.storageKey as string);
}

/** Best-effort removal of objects whose rows are already gone. Never throws; failures are audited so nothing is silently orphaned. */
export async function purgeStorageObjects(keys: string[], context: { actorId: string | null | undefined; reason: string; leadId?: string; contactId?: string }): Promise<void> {
  if (keys.length === 0) return;
  const failed: string[] = [];
  for (const key of keys) {
    try {
      if (!isStorageConfigured()) throw new Error("not configured");
      await objectStorage.remove(key);
    } catch {
      failed.push(key);
    }
  }
  if (failed.length > 0) {
    await auditAttachment({
      action: "ATTACHMENT_STORAGE_ORPHANED",
      actorId: context.actorId,
      attachmentId: "bulk",
      leadId: context.leadId,
      contactId: context.contactId,
      metadata: { reason: context.reason, storageKeys: failed.slice(0, 200), failedCount: failed.length },
    });
  }
}

/**
 * Removes uploads that were authorised but never completed (browser closed, network drop, rejected file). Idempotent; run from the
 * daily cron. The row is only deleted once its object is confirmed gone, so a transient R2 failure is retried on the next run.
 */
export async function sweepStalePendingAttachments(now: number = Date.now()): Promise<{ removed: number; failed: number }> {
  const stale = await prisma.attachment.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now - PENDING_UPLOAD_TTL_MS) } },
    select: { id: true, storageKey: true },
    take: 200,
  });
  let removed = 0;
  let failed = 0;
  for (const row of stale) {
    try {
      if (row.storageKey && isStorageConfigured()) await objectStorage.remove(row.storageKey);
      await prisma.attachment.deleteMany({ where: { id: row.id, status: "PENDING" } });
      removed++;
    } catch {
      failed++;
    }
  }
  return { removed, failed };
}
