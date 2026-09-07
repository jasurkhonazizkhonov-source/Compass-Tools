"use server";

import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { getGoogleClientId, getGoogleClientSecret } from "@/server/auth/google-config";
import { getGmailOAuth2Client, GMAIL_CONNECT_SCOPES } from "@/server/auth/gmail-oauth-config";
import { GMAIL_OAUTH_STATE_COOKIE } from "@/server/auth/gmail-oauth-state";
import { decryptRefreshToken } from "@/server/security/gmail-token-encryption";

const isProd = process.env.NODE_ENV === "production";
const STATE_MAX_AGE_SECONDS = 10 * 60;

/**
 * Starts the "Connect Gmail" consent flow for the currently signed-in CRM
 * user. `access_type: offline` + `prompt: consent` guarantees Google
 * returns a refresh token every time (including on a reconnect), not just
 * on first-ever consent.
 */
export async function startGmailConnect() {
  const current = await getCurrentAccount();
  if (!current) {
    redirect("/login");
  }

  const state = randomBytes(32).toString("base64url");
  const cookieStore = await cookies();
  cookieStore.set(GMAIL_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: STATE_MAX_AGE_SECONDS,
  });

  const client = getGmailOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_CONNECT_SCOPES,
    state,
  });

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
