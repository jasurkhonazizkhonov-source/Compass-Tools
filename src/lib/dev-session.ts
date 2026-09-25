import { cache } from "react";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

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

// Session tokens are always randomBytes(32).toString("base64url") — 43
// characters from [A-Za-z0-9_-] (see establishSession). A cookie that cannot
// possibly be one (garbage, a NUL byte, megabytes of padding) is rejected
// BEFORE any database lookup: it costs a bot nothing to send thousands of
// those, and each one would otherwise be a wasted round trip (a NUL byte
// even makes Postgres itself raise "invalid byte sequence"). The lower bound
// is deliberately loose (4) — this is a shape filter, not a security check;
// the database lookup remains the only authority on a token's validity.
export function isPlausibleSessionToken(token: string | undefined): token is string {
  return !!token && /^[A-Za-z0-9_-]{4,256}$/.test(token);
}

export function isSessionExpired(sessionCreatedAt: Date | null): boolean {
  if (!sessionCreatedAt) return true;
  return Date.now() - sessionCreatedAt.getTime() > SESSION_MAX_AGE_MS;
}

// Real, measured performance defect found and fixed: this session lookup
// runs `prisma.account.findUnique` and is called by (crm)/layout.tsx AND
// independently again by all 26 CRM page components (plus components like
// <CompanyLogo>) — so every single CRM page load performed the IDENTICAL
// account query at least twice, with nothing deduplicating them. Measured
// against the live production deployment, one database round trip there
// currently costs roughly 600ms (an unauthenticated /login render, which
// short-circuits before any query, averaged ~256ms; /quote/<invalid>,
// which performs exactly one indexed findUnique before notFound(),
// averaged ~890ms across repeated samples) — so this duplication alone was
// costing well over half a second on every CRM navigation.
//
// React's cache() is the standard, documented Next.js App Router remedy
// for exactly this "same data needed by both a layout and a page" case,
// and is already used in this codebase for getMyQueueStatus. It memoizes
// strictly within ONE request's render scope and is reset for every new
// request — no value is ever shared across requests or between users, so
// this carries none of the cross-user risk a route- or fetch-level cache
// would. Verified safe for this specific function before applying: it
// takes no arguments and reads only the request's own (immutable-within-a-
// request) cookie; no caller mutates the returned Account object; and no
// code path updates the account and then re-reads it expecting fresh data
// within the same request (establishSession takes an explicit accountId
// and never re-reads, signOut queries by token directly rather than
// through this function, and heartbeat reads once before writing).
export const getCurrentAccount = cache(async () => {
  const cookieStore = await cookies();
  const token = cookieStore.get(DEV_ACCOUNT_COOKIE)?.value;
  if (!isPlausibleSessionToken(token)) return null;

  const account = await prisma.account.findUnique({ where: { activeSessionId: token } });
  if (!account) return null; // token doesn't match any account's current session (never issued, signed out, or superseded by a newer login elsewhere)
  if (isSessionExpired(account.sessionCreatedAt)) {
    // Lazily-detected expiry — the same "next request notices it" model
    // proxy.ts already relies on for redirecting an expired session (there
    // is no background timer in this dev architecture). The moment any
    // request surfaces an expired session for this account it is treated as
    // signed out.
    return null;
  }

  return account;
});
