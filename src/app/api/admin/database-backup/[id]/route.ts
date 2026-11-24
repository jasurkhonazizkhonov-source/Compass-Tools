import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageDatabaseBackups } from "@/lib/permissions";
import { requireRecentLogin } from "@/server/security/privileged-access";
import { BackupError, deleteStagedBackup, resolveStagedBackup } from "@/server/backup/database-backup";
import { safeErrorTag } from "@/lib/safe-error-log";

// Download one staged database backup (created on the Admin "Database Backup" page). The route authorises FIRST and only then produces bytes:
//   - no session                                  -> 401
//   - a signed-in account that is not an Admin    -> 403 (the same answer whatever the id, so nothing is learned about what exists)
//   - an Admin whose sign-in is older than the step-up window -> 403
//   - an id that is not exactly one of the names this application generates, or has no staged file (or an expired one) -> 404
// The file is streamed from disk (never read into memory), with the type and name chosen here, and removed once it has been sent in full. It is never reachable by a URL that
// needs no session: there is no signed or public link of any kind.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: NO_STORE });

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE") return json({ error: "Sign in required" }, 401);
  if (!canManageDatabaseBackups(actor.role)) return json({ error: "Not available" }, 403);
  const stepUp = requireRecentLogin(actor.sessionCreatedAt);
  if (!stepUp.ok) return json({ error: "For security, downloading a backup requires a recent sign-in. Sign out, sign back in, then try again." }, 403);

  let staged: Awaited<ReturnType<typeof resolveStagedBackup>>;
  try {
    staged = await resolveStagedBackup(id);
  } catch (err) {
    if (err instanceof BackupError) return json({ error: "That backup does not exist or has expired." }, 404);
    console.error(`[database-backup] DOWNLOAD_LOOKUP_FAILED (${safeErrorTag(err)})`);
    return json({ error: "The backup could not be read." }, 500);
  }

  try {
    await prisma.auditLog.create({ data: { actorId: actor.id, action: "DATABASE_BACKUP_DOWNLOADED", entityType: "DatabaseBackup", entityId: staged.info.id, metadata: { sizeBytes: staged.info.sizeBytes } } });
  } catch (err) {
    console.error(`[database-backup] AUDIT_WRITE_FAILED (${safeErrorTag(err)})`);
  }

  const stream = createReadStream(staged.path);
  let sentInFull = false;
  stream.on("end", () => {
    sentInFull = true;
  });
  stream.on("close", () => {
    // Removed after a COMPLETE read only: a download that failed halfway can be tried again until the file expires.
    if (sentInFull) void deleteStagedBackup(staged.info.id).catch(() => undefined);
  });

  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${staged.info.fileName}"`,
      "Content-Length": String(staged.info.sizeBytes),
      "X-Content-Type-Options": "nosniff",
      "X-Backup-SHA256": staged.info.sha256,
      ...NO_STORE,
    },
  });
}
