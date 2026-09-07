"use server";

import { redirect } from "next/navigation";
import { verifyGoogleIdToken } from "@/server/auth/verify-google-token";
import { authorizeGoogleUser } from "@/server/auth/google-authorization";
import { establishSession } from "@/server/actions/dev-session";

export type GoogleSignInResult = { ok: true } | { ok: false; kind: "GOOGLE_VERIFICATION_FAILED" };

/**
 * The Google Sign-In callback entry point — called from the client with
 * the ID token (credential) Google Identity Services handed the browser.
 * Order matters: identity is verified FIRST (LAYER 1), then CRM
 * authorization is checked (LAYER 2), and only if both succeed is a CRM
 * session established. A session must never be created before both checks
 * pass.
 */
export async function signInWithGoogle(idToken: string): Promise<GoogleSignInResult> {
  const verified = await verifyGoogleIdToken(idToken);
  if (!verified) {
    return { ok: false, kind: "GOOGLE_VERIFICATION_FAILED" };
  }

  const authResult = await authorizeGoogleUser(verified.email);
  if (!authResult.ok) {
    // Server-log-only audit signal — the reason (unknown email vs. disabled
    // account) is never surfaced to the client; /access-denied always shows
    // the same generic message regardless of which one this was.
    console.warn(`[google-auth] CRM access denied for verified Google email (reason=${authResult.reason})`);
    redirect("/access-denied");
  }

  await establishSession(authResult.account.id);
  redirect("/dashboard");
}
