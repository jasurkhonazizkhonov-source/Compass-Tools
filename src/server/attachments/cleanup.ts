import { prisma } from "@/lib/prisma";
import { PENDING_UPLOAD_TTL_MS } from "@/lib/attachments/policy";
import { localStorage } from "@/server/storage/local";
import { auditAttachment } from "@/server/attachments/audit";

// Keeping PostgreSQL and the file store consistent. The two cannot share a transaction, so every path is ordered so that the failure mode
// is "an extra file" (invisible, collectable) rather than "a visible attachment with no bytes":
//   • upload  — row PENDING first; READY only after the stored file is verified; stale PENDING rows are swept here.
//   • delete  — the file is removed first, then the row; a failure between the two leaves a row the user can simply delete again
//               (deleting an already-missing file succeeds).
//   • lead / contact deletion (database cascade removes the rows) — the stored files' references are collected BEFORE the delete and
//               purged after it; a purge that fails is recorded in the audit log with the opaque keys so it can be reconciled.
// Every removal goes through the local storage module, which accepts nothing but its own key shape, so nothing here can delete a file
// outside the upload directory.

/** The opaque storage keys of these leads' files, read before a cascade delete removes the rows. */
export async function storageKeysForLeads(where: { leadId?: string; contactId?: string }): Promise<string[]> {
  const rows = await prisma.attachment.findMany({
    where: { storageKey: { not: null }, ...(where.leadId ? { leadId: where.leadId } : {}), ...(where.contactId ? { lead: { is: { contactId: where.contactId } } } : {}) },
    select: { storageKey: true },
  });
  return rows.map((r) => r.storageKey as string);
}

/** Best-effort removal of stored files whose rows are already gone. Never throws; failures are audited so nothing is silently orphaned. */
export async function purgeStorageObjects(keys: string[], context: { actorId: string | null | undefined; reason: string; leadId?: string; contactId?: string }): Promise<void> {
  if (keys.length === 0) return;
  const failed: string[] = [];
  for (const key of keys) {
    try {
      await localStorage.remove(key);
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
 * Removes uploads that were authorised but never completed (browser closed, network drop, rejected file), and upload temp files left by a
 * cut-off request. Idempotent; run from the daily cron.
 *
 * Safety against concurrent requests: the stale rows are SELECTed `FOR UPDATE SKIP LOCKED` inside one transaction and, only while that
 * lock is held, their file is removed and the row deleted. A completion (`UPDATE ... WHERE status = 'PENDING'`) on the same row waits for
 * the lock: if the sweep wins, the completion finds no row and reports failure; if the completion committed first, the row is READY, no
 * longer matches `status = 'PENDING'` and is not selected at all, so a file that a READY attachment depends on is never removed. A row
 * another transaction already holds is skipped (SKIP LOCKED) and collected by a later run. A row is deleted only once its file is
 * confirmed gone (or was already absent), so a transient filesystem error is retried on the next run instead of orphaning the file.
 */
export async function sweepStalePendingAttachments(now: number = Date.now()): Promise<{ removed: number; failed: number; tempFilesRemoved: number }> {
  const cutoff = new Date(now - PENDING_UPLOAD_TTL_MS);
  let removed = 0;
  let failed = 0;
  try {
    await prisma.$transaction(
      async (tx) => {
        const stale = await tx.$queryRaw<{ id: string; storageKey: string | null }[]>`
          SELECT "id", "storageKey" FROM "Attachment"
          WHERE "status" = 'PENDING' AND "createdAt" < ${cutoff}
          ORDER BY "createdAt"
          LIMIT 200
          FOR UPDATE SKIP LOCKED`;
        for (const row of stale) {
          try {
            // The row is kept if the file cannot be confirmed gone; the next run retries.
            if (row.storageKey) await localStorage.remove(row.storageKey);
          } catch {
            failed++;
            continue;
          }
          await tx.attachment.delete({ where: { id: row.id } });
          removed++;
        }
      },
      { timeout: 60_000, maxWait: 10_000 }
    );
  } catch {
    // The database failed mid-run: the transaction rolled back, so no row was removed (a file removed earlier in the run is simply
    // absent, and removing an absent file succeeds on the next run).
    removed = 0;
    failed++;
  }
  const tempFilesRemoved = await localStorage.sweepTempFiles(now, PENDING_UPLOAD_TTL_MS).catch(() => 0);
  return { removed, failed, tempFilesRemoved };
}
