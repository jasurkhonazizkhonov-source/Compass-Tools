import { OAuth2Client } from "google-auth-library";
import { getGoogleClientId, getGoogleClientSecret } from "@/server/auth/google-config";
import { resolveBaseUrl } from "@/lib/company-config";

// Configuration for the "Connect Gmail" authorization-code flow — separate
// from Google Sign-In (which only ever verifies an ID token, never does a
// redirect/code exchange). Shares the SAME Google OAuth client
// (GOOGLE_CLIENT_ID/SECRET) as sign-in — no second OAuth client needed —
// but requests an additional, explicit scope the user must separately
// consent to.

// Minimum scope needed to send email as the user. openid+email ride
// along so the token exchange also returns a verifiable ID token,
// confirming which Gmail address was actually granted (checked against the
// signed-in CRM account's own email — see gmail-connect.ts).
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

// Reply detection (automatic stop of a sequence when the customer answers). The NARROWEST scope that can see a reply: message METADATA only (labels and
// headers - never the body, never an attachment), deliberately NOT gmail.readonly or gmail.modify. The CRM asks Gmail only about conversations that one of
// its own sequence emails started (by thread id); it never lists, searches or reads the rest of the mailbox. Google classifies this as a restricted scope: a
// production deployment that serves people outside the Google Workspace organisation that owns the OAuth client needs Google's verification for it (see
// docs/DEPLOYMENT.md, "Reply detection"). It is OPTIONAL for connecting: a user who does not grant it (or whose connection pre-dates it) can still send, and the
// CRM says plainly that replies are not being detected for that mailbox.
export const GMAIL_METADATA_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
export const GMAIL_CONNECT_SCOPES = [GMAIL_SEND_SCOPE, GMAIL_METADATA_SCOPE, "openid", "email"];

/** True when Google granted the read-only metadata permission that reply detection needs. */
export function hasReplyDetectionScope(scopes: readonly string[]): boolean {
  return scopes.includes(GMAIL_METADATA_SCOPE);
}

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
