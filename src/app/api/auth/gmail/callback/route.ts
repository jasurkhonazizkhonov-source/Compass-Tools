import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { resolveBaseUrl } from "@/lib/company-config";
import { getGmailOAuth2Client } from "@/server/auth/gmail-oauth-config";
import { GMAIL_OAUTH_STATE_COOKIE } from "@/server/auth/gmail-oauth-state";
import { verifyGoogleIdToken } from "@/server/auth/verify-google-token";
import { normalizeEmail } from "@/server/auth/google-authorization";
import { encryptRefreshToken } from "@/server/security/gmail-token-encryption";

// Gmail "Connect" OAuth callback — a real Route Handler (not a Server
// Action) because Google redirects the browser here with a GET request and
// query parameters; a Server Action can't be the target of an external
// redirect. The CRM user this connection belongs to is ALWAYS re-derived
// from the existing session cookie via getCurrentAccount() here, never
// from `state` or any query/client-supplied value — `state` exists solely
// for CSRF protection (proving this request followed a redirect this app
// actually issued), not identity.
export async function GET(request: NextRequest) {
  // Same Vercel-aware resolution as getGmailRedirectUri() (which built the
  // redirect_uri Google was actually given) — must never diverge from it,
  // or a production deployment relying on Vercel's auto-injected URL
  // (APP_BASE_URL unset) would send the user back to a broken localhost
  // link after they already completed Google's consent screen.
  const baseUrl = resolveBaseUrl();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(GMAIL_OAUTH_STATE_COOKIE)?.value;
  cookieStore.delete(GMAIL_OAUTH_STATE_COOKIE);

  function toDashboard(gmailParam: string) {
    return NextResponse.redirect(`${baseUrl}/dashboard?gmail=${gmailParam}`);
  }

  // The user declined consent on Google's screen, or Google reported some
  // other authorization error — a normal, expected outcome, not a bug.
  if (oauthError) {
    return toDashboard("cancelled");
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    return toDashboard("error");
  }

  const current = await getCurrentAccount();
  if (!current) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  let tokens;
  try {
    const client = getGmailOAuth2Client();
    ({ tokens } = await client.getToken(code));
  } catch {
    // Deliberately never logs the caught error — a token-exchange failure
    // from the OAuth library can embed request/response details that touch
    // token material.
    console.error("[gmail-connect] token exchange failed");
    return toDashboard("error");
  }

  if (!tokens.refresh_token) {
    // Should not happen given prompt=consent+access_type=offline, but fail
    // safe rather than store a connection that can never actually send.
    console.error("[gmail-connect] no refresh_token in token response");
    return toDashboard("error");
  }

  if (!tokens.id_token) {
    console.error("[gmail-connect] no id_token in token response — cannot verify granted account");
    return toDashboard("error");
  }

  const verified = await verifyGoogleIdToken(tokens.id_token);
  if (!verified) {
    return toDashboard("error");
  }

  // The connected Gmail account must be the SAME identity the user signed
  // into the CRM with — otherwise "Connect Gmail" could silently attach a
  // stranger's mailbox to this CRM account, or an agent could send as a
  // different person's Gmail than the one their CRM identity is based on.
  if (normalizeEmail(verified.email) !== normalizeEmail(current.email)) {
    return toDashboard("mismatch");
  }

  const encryptedRefreshToken = encryptRefreshToken(tokens.refresh_token);
  const scopes = (tokens.scope ?? "").split(" ").filter(Boolean);

  await prisma.gmailConnection.upsert({
    where: { accountId: current.id },
    create: {
      accountId: current.id,
      googleEmail: verified.email,
      scopes,
      encryptedRefreshToken,
      status: "CONNECTED",
    },
    update: {
      googleEmail: verified.email,
      scopes,
      encryptedRefreshToken,
      status: "CONNECTED",
      revokedAt: null,
    },
  });

  return toDashboard("connected");
}
