"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { DEV_ACCOUNT_COOKIE, getCurrentAccount } from "@/lib/dev-session";

// Session ISSUANCE lives in src/server/auth/establish-session.ts — deliberately NOT here: everything exported from a
// "use server" file is a network-callable Server Action, and issuing a session for an account id must never be one.

/**
 * Real server-side sign-out: invalidates the session at its source
 * (Account.activeSessionId cleared, so the token this browser is holding
 * can never be reused even if the cookie itself weren't also cleared) and
 * clears the cookie, then redirects to the sign-in bootstrap page. Client-
 * side cookie clearing alone would not be sufficient — a captured cookie
 * value would otherwise keep working.
 */
export async function signOut() {
  const cookieStore = await cookies();
  const token = cookieStore.get(DEV_ACCOUNT_COOKIE)?.value;

  if (token) {
    await prisma.account.updateMany({
      where: { activeSessionId: token },
      data: { activeSessionId: null, sessionCreatedAt: null },
    });
  }

  cookieStore.delete(DEV_ACCOUNT_COOKIE);
  redirect("/login");
}

/**
 * PresenceHeartbeat (a Client Component) calls this directly, which makes
 * it a real network-callable server action regardless of the accountId
 * prop the component happens to be rendered with — a caller could invoke
 * it with any id. Re-derive the actor from the session instead of trusting
 * the parameter, so this can only ever touch the caller's own
 * lastSeenAt, never another account's presence indicator.
 */
// A heartbeat that lands within this window of the previous one carries no
// new information for the online/offline indicator, so it skips the write
// (one fewer database round trip per poll; multiple windows/devices of the
// same person otherwise each wrote every 45s).
const HEARTBEAT_MIN_WRITE_INTERVAL_MS = 30_000;

export async function heartbeat() {
  const actor = await getCurrentAccount();
  if (!actor) return;
  if (actor.lastSeenAt && Date.now() - actor.lastSeenAt.getTime() < HEARTBEAT_MIN_WRITE_INTERVAL_MS) return;
  await prisma.account.update({
    where: { id: actor.id },
    data: { lastSeenAt: new Date() },
  });
}
