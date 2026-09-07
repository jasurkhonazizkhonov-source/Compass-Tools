// Authorization layer for a FUTURE Google OAuth login — not wired to any
// actual login route yet. No Google SDK/OAuth client is added by this
// file; it does not perform authentication (verifying "who is this
// person") at all. It only implements LAYER 2 from the design: given an
// email address some other, not-yet-built layer has already verified
// belongs to the person making the request, decide whether the CRM grants
// that person access, and with what role.
//
// Deliberate separation of concerns:
//   LAYER 1 (authentication, NOT built here): Google confirms "this person
//     controls this Google account" and hands back a verified email. That
//     will eventually live in a route handler that validates Google's
//     token/response server-side — never trusting an email submitted
//     directly from the browser as proof of identity.
//   LAYER 2 (authorization, THIS file): the CRM's own decision of whether
//     a verified identity may use it, and as what role. This layer never
//     trusts Google's success alone — an unknown or disabled email is
//     denied even though Google-side authentication succeeded.
//
// The eventual Google login route will call authorizeGoogleUser() with the
// verified email from Google's response and act on the result — but until
// that route exists, this module has no effect on the app's current
// (dev-cookie-based) login flow, which continues to work exactly as before.
import { prisma } from "@/lib/prisma";
import type { Account } from "@/generated/prisma/client";

export type GoogleAuthorizationResult =
  | { ok: true; account: Account }
  | { ok: false; reason: "UNKNOWN_EMAIL" | "ACCOUNT_DISABLED" };

/** Trim + lowercase — the minimum consistent normalization so
 * "Sarah@Example.com" and "sarah@example.com" are treated as the same
 * identity and never silently create/match two different accounts. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The single authorization decision point for a future Google-authenticated
 * request. Takes an email that has ALREADY been verified by Google — this
 * function has no way to verify identity itself and must never be given
 * anything else to trust (e.g. a plain string submitted from a login form
 * would NOT be an appropriate caller of this function; only a verified
 * OAuth callback result would be).
 *
 * Decision tree (mirrors the CRM's existing dev-session authorization
 * model — an Account must exist and be ACTIVE — rather than introducing a
 * second, parallel authorization system):
 *   1. No Account with this email exists       -> UNKNOWN_EMAIL, deny.
 *      (Google auth succeeding is NOT enough on its own — the
 *      Administrator must have already created the user in /users first.
 *      This function never auto-creates an Account or assigns a default
 *      role.)
 *   2. Account exists but status !== "ACTIVE"  -> ACCOUNT_DISABLED, deny.
 *   3. Account exists and is ACTIVE             -> allow; the caller reads
 *      `account.role` directly off the returned row — the role always
 *      comes from this database column, never from Google or from
 *      anything the client supplied.
 */
export async function authorizeGoogleUser(verifiedEmail: string): Promise<GoogleAuthorizationResult> {
  const normalized = normalizeEmail(verifiedEmail);

  // Case-insensitive match against the stored email — the same
  // `mode: "insensitive"` pattern already used elsewhere in this codebase
  // for search (e.g. getContacts/getLeads), not a new comparison strategy.
  const account = await prisma.account.findFirst({
    where: { email: { equals: normalized, mode: "insensitive" } },
  });

  if (!account) {
    return { ok: false, reason: "UNKNOWN_EMAIL" };
  }
  if (account.status !== "ACTIVE") {
    return { ok: false, reason: "ACCOUNT_DISABLED" };
  }
  return { ok: true, account };
}

/** User-facing copy for each denial reason — for the future login route to
 * display. Not used anywhere yet (no route calls this module), defined
 * here so the wording stays consistent with the rest of this decision
 * layer once that route exists. */
export const GOOGLE_AUTH_DENIAL_MESSAGES: Record<Extract<GoogleAuthorizationResult, { ok: false }>["reason"], string> = {
  UNKNOWN_EMAIL: "This Google account isn't associated with a Compass Tools user. Ask your administrator to create your account first.",
  ACCOUNT_DISABLED: "Your Google account was authenticated successfully, but your CRM account does not currently have access. Please contact your administrator.",
};
