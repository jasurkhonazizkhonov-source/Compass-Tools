"use server";

import { verifyGoogleIdToken } from "@/server/auth/verify-google-token";
import { authorizeGoogleUser } from "@/server/auth/google-authorization";
import { bootstrapInitialAdminIfEligible } from "@/server/auth/initial-admin-bootstrap";
import { establishSession } from "@/server/actions/dev-session";

// Pass 37 — real bug found and fixed: this action used to call next/
// navigation's redirect() directly on both the success and denial paths.
// redirect() works by throwing a special digest error that Next's own
// client-side action machinery is expected to intercept and turn into a
// real navigation — but this action is invoked from a Google Identity
// Services credential callback (google-sign-in-button.tsx), a plain
// function reference Google's own external script calls directly, OUTSIDE
// any React event handler or transition. The codebase's own pre-existing
// test file for this action already modeled redirect() as "throws to
// unwind" (see google-auth.test.ts's redirect mock comment) — and the
// client's call site was `signInWithGoogle(...).then(onFulfilled)` with NO
// second (rejection) argument and no .catch(). A rejected promise there
// never runs the .then() callback at all, so `isSigningIn` (and the
// "Signing in…" UI) never got reset — on ANY outcome, success included,
// depending on whether Next's redirect-interception happened to still fire
// correctly from this out-of-band caller. This is the exact reported
// "stuck on Signing in… forever" production bug.
//
// Fixed by never calling redirect() from this action at all: it now always
// resolves to a plain, discriminated result, and the CLIENT (which knows
// it's running inside a real browser navigation context) performs the
// actual router.push() itself. This removes the ambiguity entirely,
// regardless of the exact Next.js version's redirect-from-bare-action
// behavior.
export type GoogleSignInResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "GOOGLE_VERIFICATION_FAILED" // transient/retryable — shown inline, never navigates away
        | "NOT_INITIALIZED" // zero Accounts exist and INITIAL_ADMIN_EMAIL is missing/blank
        | "BOOTSTRAP_EMAIL_MISMATCH" // zero Accounts exist, INITIAL_ADMIN_EMAIL is configured, this identity isn't it
        | "ACCESS_DENIED"; // one or more Accounts already exist; this identity has none (or it's disabled)
    };

/**
 * The Google Sign-In callback entry point — called from the client with
 * the ID token (credential) Google Identity Services handed the browser.
 * Order matters:
 *   1. Identity is verified FIRST (LAYER 1) — nothing below ever runs on
 *      an unverified token.
 *   2. The initial-admin bootstrap check (LAYER 0) runs next — it only
 *      ever has an effect while the deployment has zero Accounts; every
 *      other sign-in falls straight through it.
 *   3. Normal CRM authorization (LAYER 2) runs only when bootstrap didn't
 *      apply.
 * A session is established only after one of steps 2/3 actually resolves
 * to a real, ACTIVE Account — never before both identity verification and
 * authorization have succeeded.
 */
export async function signInWithGoogle(idToken: string): Promise<GoogleSignInResult> {
  const verified = await verifyGoogleIdToken(idToken);
  if (!verified) {
    return { ok: false, reason: "GOOGLE_VERIFICATION_FAILED" };
  }

  const bootstrap = await bootstrapInitialAdminIfEligible(verified.email, verified.name);
  if (bootstrap.outcome === "created") {
    await establishSession(bootstrap.account.id);
    return { ok: true };
  }
  if (bootstrap.outcome === "not_initialized") {
    console.warn("[google-auth] sign-in attempted before the CRM was initialized (INITIAL_ADMIN_EMAIL is not configured)");
    return { ok: false, reason: "NOT_INITIALIZED" };
  }
  if (bootstrap.outcome === "email_mismatch") {
    console.warn("[google-auth] initial-admin bootstrap attempted by a Google account that does not match INITIAL_ADMIN_EMAIL");
    return { ok: false, reason: "BOOTSTRAP_EMAIL_MISMATCH" };
  }

  // bootstrap.outcome === "not_applicable" — at least one Account already
  // exists; normal, permanent authorization takes over from here on.
  const authResult = await authorizeGoogleUser(verified.email);
  if (!authResult.ok) {
    // Server-log-only audit signal — the reason (unknown email vs.
    // disabled account) is never surfaced to the client; ACCESS_DENIED
    // shows the same generic message regardless of which one this was.
    console.warn(`[google-auth] CRM access denied for verified Google email (reason=${authResult.reason})`);
    return { ok: false, reason: "ACCESS_DENIED" };
  }

  await establishSession(authResult.account.id);
  return { ok: true };
}
