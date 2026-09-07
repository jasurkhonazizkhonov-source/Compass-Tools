import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { destroyCvvAuthorizationsForAccount } from "@/server/security/cvv-cache";

// Server-side session lifecycle for the real Google-authenticated login
// (see src/app/login/page.tsx, src/server/actions/google-auth.ts, and
// src/server/auth/google-authorization.ts for the authorization-decision
// layer the login route calls into). The cookie holds an opaque,
// unguessable session TOKEN (never the account id itself), matched against
// Account.activeSessionId, with a real absolute 24h expiry and real
// single-active-device enforcement — issuing a new token overwrites the
// old one, so a session open on a second device stops matching on its very
// next request. See src/proxy.ts for where this is enforced on every
// route, and src/server/actions/dev-session.ts for session issuance/
// sign-out. (File/cookie names keep their original "dev-session" naming —
// this layer was already real before Google auth landed and did not need
// to change; only the login step that issues the session changed.)
export const DEV_ACCOUNT_COOKIE = "compass_dev_account";
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isSessionExpired(sessionCreatedAt: Date | null): boolean {
  if (!sessionCreatedAt) return true;
  return Date.now() - sessionCreatedAt.getTime() > SESSION_MAX_AGE_MS;
}

export async function getCurrentAccount() {
  const cookieStore = await cookies();
  const token = cookieStore.get(DEV_ACCOUNT_COOKIE)?.value;
  if (!token) return null;

  const account = await prisma.account.findUnique({ where: { activeSessionId: token } });
  if (!account) return null; // token doesn't match any account's current session (never issued, signed out, or superseded by a newer login elsewhere)
  if (isSessionExpired(account.sessionCreatedAt)) {
    // Lazily-detected expiry — the same "next request notices it" model
    // proxy.ts already relies on for redirecting an expired session (there
    // is no background timer in this dev architecture). The moment any
    // request surfaces an expired session for this account, destroy any
    // supplier-payment CVV authorization it was actively holding, per the
    // "invalidate privileged payment access / destroy temporary CVV state
    // on expiry" requirement.
    destroyCvvAuthorizationsForAccount(account.id);
    return null;
  }

  return account;
}
