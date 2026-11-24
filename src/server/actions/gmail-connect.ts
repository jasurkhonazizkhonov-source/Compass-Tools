"use server";

import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { getGoogleClientId, getGoogleClientSecret } from "@/server/auth/google-config";
import { getGmailOAuth2Client, getGmailRedirectUri, GMAIL_CONNECT_SCOPES } from "@/server/auth/gmail-oauth-config";
import { GMAIL_OAUTH_STATE_COOKIE, GMAIL_RETURN_COOKIE, safeGmailReturnPath } from "@/server/auth/gmail-oauth-state";
import { decryptRefreshToken } from "@/server/security/gmail-token-encryption";
import { checkAccountRateLimit, describeWait, RATE_LIMITS } from "@/server/security/rate-limit";

const isProd = process.env.NODE_ENV === "production";
const STATE_MAX_AGE_SECONDS = 10 * 60;

/**
 * Starts the "Connect Gmail" consent flow for the currently signed-in CRM
 * user. `access_type: offline` + `prompt: consent` guarantees Google
 * returns a refresh token every time (including on a reconnect), not just
 * on first-ever consent.
 */
export async function startGmailConnect(returnTo?: string) {
  const current = await getCurrentAccount();
  if (!current) {
    redirect("/login");
  }
  // Each start is a trip to Google: bounded per account (never per IP, so a shared office is unaffected).
  const limit = await checkAccountRateLimit(current.id, "GMAIL_CONNECT", RATE_LIMITS.GMAIL_CONNECT);
  if (!limit.allowed) throw new Error(`Too many Gmail connection attempts. Please try again in ${describeWait(limit.retryAfterSeconds)}.`);

  const state = randomBytes(32).toString("base64url");
  const cookieStore = await cookies();
  cookieStore.set(GMAIL_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: STATE_MAX_AGE_SECONDS,
  });

  // Started from a Lead's sequence panel: remember that lead page so the callback can bring the user straight back to it (validated, same-origin path only).
  const returnPath = safeGmailReturnPath(returnTo);
  if (returnPath) {
    cookieStore.set(GMAIL_RETURN_COOKIE, returnPath, { httpOnly: true, secure: isProd, sameSite: "lax", path: "/", maxAge: STATE_MAX_AGE_SECONDS });
  } else {
    cookieStore.set(GMAIL_RETURN_COOKIE, "", { httpOnly: true, secure: isProd, sameSite: "lax", path: "/", maxAge: 0 });
  }

  const client = getGmailOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_CONNECT_SCOPES,
    state,
  });

  // Diagnostic marker, paired with [gmail-connect] CALLBACK_RECEIVED in the
  // callback route. Together they answer the single most important question
  // when "Connect Gmail" fails: did Google ever hand the browser back to
  // this deployment at all?
  //   START logged, CALLBACK_RECEIVED absent  -> Google rejected the request
  //     before redirecting (redirect_uri not registered for this OAuth
  //     client, consent/verification block, disabled client). Nothing in
  //     this application can recover from that; it is Google Cloud Console
  //     configuration. This was the CONFIRMED cause of the reported
  //     "compass-tools.com is blocked": probing Google's authorize endpoint
  //     with this app's exact parameters returned error
  //     `redirect_uri_mismatch` for the production host, the apex host, AND
  //     localhost — i.e. no Gmail callback URI is registered at all. Google
  //     Sign-In is unaffected because Identity Services uses the ID-token
  //     flow, which validates an Authorized JavaScript ORIGIN and never a
  //     redirect URI — which is exactly why one works and the other does not.
  //   Both logged -> the failure is on this side; see the callback's own
  //     categorised log lines.
  // The redirect URI is not a secret (it is sent to Google in a URL the
  // browser can read) and is logged verbatim on purpose: it is the exact
  // string that must appear under "Authorized redirect URIs" for this
  // OAuth client, so an operator can copy it straight out of the logs.
  console.info(`[gmail-connect] START redirect_uri=${getGmailRedirectUri()}`);

  redirect(url);
}

/**
 * Explicit user-initiated disconnect — removes the connection entirely
 * (distinct from the REVOKED status, which is set only when a send attempt
 * detects Google itself invalidated the token; an explicit disconnect
 * doesn't need that history, it's a clean "never connected" state).
 *
 * Also best-effort revokes the grant at Google itself (POST to Google's
 * /revoke endpoint) before deleting the local row — otherwise "Disconnect"
 * only forgets the token on our side while the underlying Google-account
 * grant silently persists until the user separately revokes it from their
 * own Google Account settings, which doesn't match what a user reasonably
 * expects "Disconnect" to do. Revocation failure (token already invalid,
 * Google unreachable) never blocks the local disconnect — the CRM-side
 * connection is removed either way, and the raw error is never logged since
 * it can echo back token material.
 */
export async function disconnectGmail() {
  const current = await getCurrentAccount();
  if (!current) {
    throw new Error("Not signed in");
  }

  const connection = await prisma.gmailConnection.findUnique({ where: { accountId: current.id } });
  if (connection) {
    try {
      const client = new OAuth2Client(getGoogleClientId(), getGoogleClientSecret());
      await client.revokeToken(decryptRefreshToken(connection.encryptedRefreshToken));
    } catch {
      // Best-effort only — never logs the caught error (may embed token
      // material), and never prevents the local disconnect below. A token
      // that's already expired/revoked at Google will fail here too, which
      // is fine: there's nothing left to revoke in that case.
      console.error("[gmail-connect] revoke-at-Google request failed (continuing with local disconnect)");
    }
  }

  await prisma.gmailConnection.deleteMany({ where: { accountId: current.id } });
  revalidatePath("/", "layout");
}
