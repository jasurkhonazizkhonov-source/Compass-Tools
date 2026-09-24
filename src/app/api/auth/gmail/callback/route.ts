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
import { defaultRouteForRole } from "@/lib/permissions";
import type { AccountRole } from "@/generated/prisma/client";

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

  // Paired with [gmail-connect] START in startGmailConnect(). If START
  // appears in the logs and this line never does, Google rejected the
  // authorization request before ever redirecting the browser back here —
  // a Google Cloud Console problem (unregistered redirect URI, consent or
  // verification block), not an application one. Logs only whether the
  // two OAuth query params are present, never their values: `code` is a
  // single-use credential and `state` is a CSRF token.
  console.info(`[gmail-connect] CALLBACK_RECEIVED hasCode=${!!code} hasState=${!!state}${oauthError ? " googleError=present" : ""}`);

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(GMAIL_OAUTH_STATE_COOKIE)?.value;
  cookieStore.delete(GMAIL_OAUTH_STATE_COOKIE);

  // Real defect found and fixed: this used to redirect unconditionally to
  // /dashboard. For any role that cannot view the Dashboard (Ticketing
  // Agent and Flight Expert land on /quotes, Marketing Agent on
  // /subscriptions — see defaultRouteForRole), src/proxy.ts immediately
  // re-redirects them to their own default route and, in doing so, DROPS
  // the ?gmail= query string. GmailConnectToast reads exactly that param,
  // so those users completed the whole OAuth consent flow and then saw no
  // confirmation and — on mismatch/error — no explanation whatsoever,
  // which reads precisely as "Connect Gmail does nothing." Sending them
  // straight to their own landing route keeps the param intact. The toast
  // lives in the shared (crm) layout, so it fires on any CRM route, not
  // just the Dashboard. `session.role` is set once the session below
  // resolves; the two call sites that run before that (declined consent,
  // bad CSRF state) legitimately have no session yet, and
  // defaultRouteForRole(undefined) returns /dashboard — the previous
  // behaviour, unchanged, for exactly those cases.
  // Held in a small mutable box rather than threaded through every
  // toDashboard() call: there are eight call sites and every one of them
  // must land on the user's own route, so a single shared value removes any
  // chance of one being missed and silently regressing to /dashboard.
  const session: { role?: AccountRole } = {};
  function toDashboard(gmailParam: string) {
    return NextResponse.redirect(`${baseUrl}${defaultRouteForRole(session.role)}?gmail=${gmailParam}`);
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
  // From here on every toDashboard() lands on THIS user's own permitted
  // route, so the ?gmail= param survives proxy.ts's role routing.
  session.role = current.role;

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

  // Real defect found and fixed: this was the one step in this route left
  // unguarded, while every other failure path above redirects cleanly to
  // ?gmail=error. encryptRefreshToken throws when
  // GMAIL_TOKEN_ENCRYPTION_KEY is unset or isn't exactly 32 decoded bytes
  // (note .env.example ships it EMPTY, so an operator who filled in only
  // the obvious variables lands here) — and it throws at the worst possible
  // moment: the user has already completed Google's consent screen, so they
  // got a raw 500 with no explanation while a live grant now existed at
  // Google with nothing stored on our side. Now it degrades to the same
  // ?gmail=error toast as every other failure, with a distinct server-side
  // log line naming the actual cause for whoever reads the logs.
  let encryptedRefreshToken: string;
  try {
    encryptedRefreshToken = encryptRefreshToken(tokens.refresh_token);
  } catch {
    // Never logs the caught error or the token — only the category.
    console.error("[gmail-connect] TOKEN_ENCRYPTION_UNAVAILABLE (GMAIL_TOKEN_ENCRYPTION_KEY missing or not a 32-byte key)");
    return toDashboard("error");
  }
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
