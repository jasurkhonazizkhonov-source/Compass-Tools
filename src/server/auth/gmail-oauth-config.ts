import { OAuth2Client } from "google-auth-library";
import { getGoogleClientId, getGoogleClientSecret } from "@/server/auth/google-config";
import { resolveBaseUrl } from "@/lib/company-config";

// Configuration for the "Connect Gmail" authorization-code flow — separate
// from Google Sign-In (which only ever verifies an ID token, never does a
// redirect/code exchange). Shares the SAME Google OAuth client
// (GOOGLE_CLIENT_ID/SECRET) as sign-in — no second OAuth client needed —
// but requests an additional, explicit scope the user must separately
// consent to.

// Minimum scope needed to send email as the user — deliberately NOT a
// broader Gmail scope (gmail.modify, gmail.readonly, etc.), since nothing
// in this CRM reads or modifies the user's mailbox. openid+email ride
// along so the token exchange also returns a verifiable ID token,
// confirming which Gmail address was actually granted (checked against the
// signed-in CRM account's own email — see gmail-connect.ts).
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_CONNECT_SCOPES = [GMAIL_SEND_SCOPE, "openid", "email"];

export function getGmailRedirectUri(): string {
  // Shares the same base-URL resolution every customer-facing link already
  // uses (APP_BASE_URL, then Vercel's auto-injected URL, then a loud
  // production warning before falling back to localhost) — this used to be
  // its own bare `APP_BASE_URL || "http://localhost:3000"`, which had no
  // Vercel-aware fallback and no warning: a production deployment that
  // relies on Vercel's auto-injected URL (real APP_BASE_URL never set)
  // would register this redirect_uri as localhost with Google, silently
  // breaking "Connect Gmail" for every user with no server-side error to
  // find, since the browser is the one that fails to reach it, not this
  // app. See src/lib/company-config.ts's resolveBaseUrl().
  const baseUrl = resolveBaseUrl();
  return `${baseUrl}/api/auth/gmail/callback`;
}

export function getGmailOAuth2Client(): OAuth2Client {
  return new OAuth2Client(getGoogleClientId(), getGoogleClientSecret(), getGmailRedirectUri());
}
