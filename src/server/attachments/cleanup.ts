import { prisma } from "@/lib/prisma";
import { PENDING_UPLOAD_TTL_MS } from "@/lib/attachments/policy";
import { removeStoredObject, type StoredObjectRef } from "@/server/storage";
import { isLegacyR2Configured } from "@/server/storage/legacy-r2";
import { localStorage } from "@/server/storage/local";
import { auditAttachment } from "@/server/attachments/audit";

// Keeping PostgreSQL and the file store consistent. The two cannot share a transaction, so every path is ordered so that the failure mode
// is "an extra file" (invisible, collectable) rather than "a visible attachment with no bytes":
//   • upload  — row PENDING first; READY only after the stored file is verified; stale PENDING rows are swept here.
//   • delete  — the file is removed first, then the row; a failure between the two leaves a row the user can simply delete again
//               (deleting an already-missing file succeeds).
//   • lead / contact deletion (database cascade removes the rows) — the stored files' references are collected BEFORE the delete and
//               purged after it; a purge that fails is recorded in the audit log with the opaque keys so it can be reconciled.
// Every removal is routed by the row's own storageProvider (src/server/storage/index.ts): a local file is only ever removed through the
// local module, which accepts nothing but its own key shape, so nothing here can delete a file outside the upload directory.

/** The stored files (provider + opaque key) of these leads, read before a cascade delete removes the rows. */
export async function storageKeysForLeads(where: { leadId?: string; contactId?: string }): Promise<StoredObjectRef[]> {
  const rows = await prisma.attachment.findMany({
    where: { storageKey: { not: null }, ...(where.leadId ? { leadId: where.leadId } : {}), ...(where.contactId ? { lead: { is: { contactId: where.contactId } } } : {}) },
    select: { storageKey: true, storageProvider: true },
  });
  return rows.map((r) => ({ provider: r.storageProvider, key: r.storageKey as string }));
}

/** Best-effort removal of stored files whose rows are already gone. Never throws; failures are audited so nothing is silently orphaned. */
export async function purgeStorageObjects(refs: StoredObjectRef[], context: { actorId: string | null | undefined; reason: string; leadId?: string; contactId?: string }): Promise<void> {
  if (refs.length === 0) return;
  const failed: StoredObjectRef[] = [];
  for (const ref of refs) {
    try {
      if (ref.provider === "R2" && !isLegacyR2Configured()) throw new Error("legacy storage not configured");
      await removeStoredObject(ref);
    } catch {
      failed.push(ref);
    }
  }
  if (failed.length > 0) {
    await auditAttachment({
      action: "ATTACHMENT_STORAGE_ORPHANED",
      actorId: context.actorId,
      attachmentId: "bulk",
      leadId: context.leadId,
      contactId: context.contactId,
      metadata: { reason: context.reason, storageKeys: failed.slice(0, 200).map((r) => r.key), providers: [...new Set(failed.map((r) => r.provider))], failedCount: failed.length },
    });
  }
}

/**
 * Removes uploads that were authorised but never completed (browser closed, network drop, rejected file), and upload temp files left by a
 * cut-off request. Idempotent; run from the daily cron. A LOCAL row is deleted only once its file is confirmed gone (or was already
 * absent), so a transient filesystem error is retried on the next run instead of orphaning the file. A row is only ever PENDING and
 * older than the one-hour window here, so a completed (READY) attachment is never touched.
 */
export async function sweepStalePendingAttachments(now: number = Date.now()): Promise<{ removed: number; failed: number; tempFilesRemoved: number }> {
  const stale = await prisma.attachment.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now - PENDING_UPLOAD_TTL_MS) } },
    select: { id: true, storageKey: true, storageProvider: true },
    take: 200,
  });
  let removed = 0;
  let failed = 0;
  for (const row of stale) {
    try {
      // Legacy R2 rows that can no longer be completed AND whose credentials are gone have nothing reachable to delete; LOCAL rows
      // always go through the local module and the row is kept if that fails.
      if (row.storageKey && (row.storageProvider === "LOCAL" || isLegacyR2Configured())) await removeStoredObject({ provider: row.storageProvider, key: row.storageKey });
      await prisma.attachment.deleteMany({ where: { id: row.id, status: "PENDING" } });
      removed++;
    } catch {
      failed++;
    }
  }
  const tempFilesRemoved = await localStorage.sweepTempFiles(now, PENDING_UPLOAD_TTL_MS).catch(() => 0);
  return { removed, failed, tempFilesRemoved };
}
