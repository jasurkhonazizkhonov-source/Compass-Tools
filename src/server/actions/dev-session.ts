"use server";

import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { DEV_ACCOUNT_COOKIE, SESSION_MAX_AGE_MS, getCurrentAccount } from "@/lib/dev-session";
import { destroyCvvAuthorizationsForAccount } from "@/server/security/cvv-cache";

const isProd = process.env.NODE_ENV === "production";

/**
 * Issues a real CRM session for an already-authorized account — called
 * only after Google authentication succeeds AND the CRM's own
 * authorization check (src/server/auth/google-authorization.ts) has
 * confirmed this account exists and is ACTIVE. Never call this with an
 * accountId that hasn't just cleared both of those checks.
 *
 * Issues a fresh, unguessable session token and overwrites the account's
 * activeSessionId with it — this is what makes single-active-device
 * enforcement real: any cookie a different device is holding for this same
 * account now points at a superseded token and stops matching on its very
 * next request (see getCurrentAccount()/proxy.ts).
 */
export async function establishSession(accountId: string) {
  const token = randomBytes(32).toString("base64url");

  // A fresh login is a fresh authentication boundary — any supplier-payment
  // CVV authorization this account was holding from a previous session
  // (this device or another) must not carry forward into the new one.
  destroyCvvAuthorizationsForAccount(accountId);

  await prisma.account.update({
    where: { id: accountId },
    data: { activeSessionId: token, sessionCreatedAt: new Date() },
  });

  const cookieStore = await cookies();
  cookieStore.set(DEV_ACCOUNT_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS / 1000, // seconds; mirrors the server-side 24h absolute expiry as defense-in-depth, not the authoritative check
  });
  revalidatePath("/", "layout");
}

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
    const account = await prisma.account.findUnique({ where: { activeSessionId: token }, select: { id: true } });
    await prisma.account.updateMany({
      where: { activeSessionId: token },
      data: { activeSessionId: null, sessionCreatedAt: null },
    });
    // Terminate any active supplier-payment CVV authorization this account
    // was holding — sign-out must clear temporary payment-authorization
    // state, not just the login session itself.
    if (account) destroyCvvAuthorizationsForAccount(account.id);
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
export async function heartbeat() {
  const actor = await getCurrentAccount();
  if (!actor) return;
  await prisma.account.update({
    where: { id: actor.id },
    data: { lastSeenAt: new Date() },
  });
}
