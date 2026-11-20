"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewFailedSignIns } from "@/lib/permissions";
import { getFailedSignInEvent, type FailedSignInRow } from "@/server/queries/failed-signins";

// Administrator-only actions on the failed sign-in log. Every action re-checks the role itself: the page, the sidebar and proxy.ts are additional layers, never
// the control. A non-admin gets the same generic refusal for everything, so nothing is revealed about the log.

const DENIED = "You are not authorized to use the failed sign-in log";
const MAX_DELETE_BATCH = 200;

async function assertAdmin() {
  const actor = await getCurrentAccount();
  if (!actor || !canViewFailedSignIns(actor.role)) throw new Error(DENIED);
  return actor;
}

export async function inspectFailedSignIn(id: string): Promise<FailedSignInRow | null> {
  const actor = await assertAdmin();
  return getFailedSignInEvent(actor.companyId, id);
}

/**
 * Deletes exactly the events that were explicitly selected (by id, at most MAX_DELETE_BATCH, and only events this Administrator may see): never "everything on the
 * page", never by date, never automatically. The rows are really removed (they hold personal data), and the deletion itself is audited with who and how many - the
 * audit entry holds no name, email or address.
 */
export async function deleteFailedSignInEvents(ids: string[]): Promise<{ ok: true; deleted: number; requested: number } | { ok: false; error: string }> {
  const actor = await assertAdmin();
  if (!Array.isArray(ids)) return { ok: false, error: "Select at least one record." };
  const unique = [...new Set(ids.filter((i): i is string => typeof i === "string" && i.length > 0 && i.length <= 64))];
  if (unique.length === 0) return { ok: false, error: "Select at least one record." };
  if (unique.length > MAX_DELETE_BATCH) return { ok: false, error: `Select at most ${MAX_DELETE_BATCH} records at a time.` };

  const result = await prisma.failedSignInEvent.deleteMany({ where: { id: { in: unique }, OR: [{ companyId: actor.companyId }, { companyId: null }] } });
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: "FAILED_SIGNINS_DELETED",
      entityType: "FailedSignInEvent",
      entityId: "bulk",
      metadata: { requested: unique.length, deleted: result.count },
    },
  });
  revalidatePath("/failed-signins");
  return { ok: true, deleted: result.count, requested: unique.length };
}
