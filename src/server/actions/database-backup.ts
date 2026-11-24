"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageDatabaseBackups } from "@/lib/permissions";
import { requireRecentLogin, RECENT_LOGIN_WINDOW_MS } from "@/server/security/privileged-access";
import { BackupError, BACKUP_EXCLUDED_DATA, BACKUP_FORMAT, createBackup, deleteStagedBackup, getBackupCapability, isValidBackupId, listStagedBackups, type BackupCapability, type BackupInfo } from "@/server/backup/database-backup";
import { safeErrorTag } from "@/lib/safe-error-log";

// Admin-only. Every function below re-checks the signed-in account on the SERVER (hiding the navigation entry is only a convenience); creating a backup also needs a sign-in within the
// last RECENT_LOGIN_WINDOW_MS (a dump is every customer record the CRM holds). Each is audited: who, what, when - never a connection string, a path or any data from the dump.
// Restoring is deliberately NOT an action: see src/server/backup/database-backup.ts and docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md.

const NOT_AVAILABLE = "Not available.";
const STEP_UP_MESSAGE = `For security, creating a database backup requires a sign-in within the last ${RECENT_LOGIN_WINDOW_MS / 60000} minutes. Sign out, sign back in, then try again.`;

export type BackupView = {
  id: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  sha256: string;
  format: string;
  pgDumpVersion: string;
  serverVersion: string;
};

const view = (b: BackupInfo): BackupView => ({
  id: b.id,
  fileName: b.fileName,
  sizeBytes: b.sizeBytes,
  createdAt: b.createdAt.toISOString(),
  expiresAt: b.expiresAt.toISOString(),
  sha256: b.sha256,
  format: b.format,
  pgDumpVersion: b.pgDumpVersion,
  serverVersion: b.serverVersion,
});

async function requireBackupAdmin() {
  const actor = await getCurrentAccount();
  if (!actor || !canManageDatabaseBackups(actor.role)) throw new Error(NOT_AVAILABLE);
  return actor;
}

async function audit(actorId: string, action: string, entityId: string, metadata: Record<string, unknown>) {
  try {
    await prisma.auditLog.create({ data: { actorId, action, entityType: "DatabaseBackup", entityId, metadata: metadata as never } });
  } catch (err) {
    // The audit write must never turn a finished backup into a failure, but a missing audit row is itself worth a line in the server log.
    console.error(`[database-backup] AUDIT_WRITE_FAILED (${safeErrorTag(err)})`);
  }
}

export type BackupStatus = {
  capability: BackupCapability;
  backups: BackupView[];
  /** Fixed facts the page states about what a backup contains. */
  format: string;
  excludedData: string;
};

/** What the Database Backup page shows: whether a backup can be made here, and the staged ones that can still be downloaded. */
export async function getDatabaseBackupStatus(): Promise<BackupStatus> {
  await requireBackupAdmin();
  const [capability, backups] = await Promise.all([getBackupCapability(), listStagedBackups()]);
  return { capability, backups: backups.map(view), format: BACKUP_FORMAT, excludedData: BACKUP_EXCLUDED_DATA };
}

export type CreateBackupResult = { ok: true; backup: BackupView } | { ok: false; error: string };

/** Creates, verifies and stages one complete backup; the download itself is a separate, authenticated request (/api/admin/database-backup/<id>). */
export async function createDatabaseBackup(): Promise<CreateBackupResult> {
  const actor = await requireBackupAdmin();
  const stepUp = requireRecentLogin(actor.sessionCreatedAt);
  if (!stepUp.ok) {
    await audit(actor.id, "DATABASE_BACKUP_DENIED", "none", { reason: stepUp.reason });
    return { ok: false, error: STEP_UP_MESSAGE };
  }
  try {
    const info = await createBackup();
    await audit(actor.id, "DATABASE_BACKUP_CREATED", info.id, { sizeBytes: info.sizeBytes, sha256: info.sha256, pgDumpVersion: info.pgDumpVersion, serverVersion: info.serverVersion });
    revalidatePath("/database-backup");
    return { ok: true, backup: view(info) };
  } catch (err) {
    const code = err instanceof BackupError ? err.code : "UNEXPECTED";
    await audit(actor.id, "DATABASE_BACKUP_FAILED", "none", { code });
    if (err instanceof BackupError) return { ok: false, error: err.message };
    console.error(`[database-backup] UNEXPECTED_FAILURE (${safeErrorTag(err)})`);
    return { ok: false, error: "The database backup failed unexpectedly. Nothing was kept. Details are in the server log." };
  }
}

/** Removes a staged backup that is no longer needed. */
export async function deleteDatabaseBackup(id: string): Promise<{ ok: boolean; error?: string }> {
  const actor = await requireBackupAdmin();
  if (!isValidBackupId(id)) return { ok: false, error: "That backup does not exist." };
  const removed = await deleteStagedBackup(id);
  if (removed) await audit(actor.id, "DATABASE_BACKUP_DELETED", id, {});
  revalidatePath("/database-backup");
  return removed ? { ok: true } : { ok: false, error: "That backup does not exist or has already been removed." };
}
