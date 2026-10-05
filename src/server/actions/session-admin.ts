"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DEV_ACCOUNT_COOKIE, getCurrentAccount } from "@/lib/dev-session";
import { canManageAccounts } from "@/lib/permissions";
import { requireRecentLogin, RECENT_LOGIN_WINDOW_MS } from "@/server/security/privileged-access";
import { safeErrorTag } from "@/lib/safe-error-log";

/**
 * "Sign out all users" — an Administrator ends every active CRM session in their company, including their own.
 *
 * What it is, precisely:
 *   • a ONE-SHOT revocation of the sessions that exist right now. There is no persistent "everyone is signed out" flag, so
 *     nothing can later invalidate a session created AFTER this ran: anyone may sign in again immediately and gets a normal
 *     fresh 24-hour session;
 *   • distinct from the 24-hour absolute expiry (time) and from single-device replacement (the same account signing in
 *     elsewhere) — it is an administrator's decision, and the signed-out user is told so ("signed out by an administrator");
 *   • atomic: one statement locks the affected rows, records each revoked token by HASH (so the old browser can be told why on
 *     its next request — no raw token is kept) and clears the live session, so a sign-in racing it either lands before (and is
 *     revoked) or after (and is valid) — never half-way.
 *
 * Server-side authorization is re-derived from the session (never from an argument): Administrator only, same company only,
 * plus the same recent-sign-in step-up as the other privileged account actions. A refusal is a RETURNED message (production
 * masks thrown action errors) and is audited. Every successful run is audited with a count only — never a token.
 */
const STEP_UP_MESSAGE = `For security, signing everyone out requires a sign-in within the last ${RECENT_LOGIN_WINDOW_MS / 60000} minutes. Sign out, sign back in, then try again.`;

export async function signOutAllUsers(): Promise<{ error: string }> {
  const current = await getCurrentAccount();
  if (!current || !canManageAccounts(current.role)) {
    return { error: "Only Administrators can sign everyone out." };
  }

  const stepUp = requireRecentLogin(current.sessionCreatedAt);
  if (!stepUp.ok) {
    await prisma.auditLog
      .create({ data: { actorId: current.id, action: "SESSIONS_SIGN_OUT_ALL_DENIED", entityType: "Company", entityId: current.companyId, metadata: { reason: stepUp.reason } } })
      .catch((err) => console.error(`[sign-out-all] denial audit failed (${safeErrorTag(err)})`));
    return { error: STEP_UP_MESSAGE };
  }

  let signedOut: number;
  try {
    signedOut = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ count: bigint }[]>`
        WITH locked AS (
          SELECT "id", "activeSessionId" AS "token" FROM "Account"
           WHERE "companyId" = ${current.companyId} AND "activeSessionId" IS NOT NULL
             FOR UPDATE
        ),
        recorded AS (
          INSERT INTO "RevokedSession" ("id", "tokenHash", "accountId", "reason", "createdAt")
          SELECT md5(random()::text || clock_timestamp()::text || "id"), encode(sha256(convert_to("token", 'UTF8')), 'hex'), "id", 'SIGNED_OUT_ALL'::"SessionRevocationReason", now()
            FROM locked
          ON CONFLICT ("tokenHash") DO NOTHING
          RETURNING 1
        ),
        cleared AS (
          UPDATE "Account" a SET "activeSessionId" = NULL, "sessionCreatedAt" = NULL, "updatedAt" = now()
            FROM locked WHERE a."id" = locked."id"
          RETURNING a."id"
        )
        SELECT count(*)::bigint AS "count" FROM cleared`;
      const count = Number(rows[0]?.count ?? 0);
      await tx.auditLog.create({
        data: { actorId: current.id, action: "SESSIONS_SIGNED_OUT_ALL", entityType: "Company", entityId: current.companyId, metadata: { sessionsEnded: count } },
      });
      return count;
    });
  } catch (err) {
    console.error(`[sign-out-all] failed (${safeErrorTag(err)})`);
    return { error: "Could not sign everyone out. Nothing was changed — please try again." };
  }
  void signedOut;

  // The Administrator's own session was among those ended: drop the cookie and send them to the sign-in page with the reason.
  (await cookies()).delete(DEV_ACCOUNT_COOKIE);
  redirect("/login?reason=signed-out-all");
}
