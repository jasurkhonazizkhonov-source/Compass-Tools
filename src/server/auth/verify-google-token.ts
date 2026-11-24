import { OAuth2Client } from "google-auth-library";
import { getGoogleClientId } from "@/server/auth/google-config";
import { nonceMatches } from "@/server/auth/google-login-binding";

// LAYER 1 (authentication): confirms "this person controls this Google
// account" by verifying the ID token Google Identity Services handed the
// browser, entirely server-side, against Google's own public keys — never
// trusting an email the browser claims. See src/server/auth/
// google-authorization.ts for LAYER 2 (CRM authorization), which this
// module has no knowledge of.

let cachedClient: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (!cachedClient) {
    cachedClient = new OAuth2Client(getGoogleClientId());
  }
  return cachedClient;
}

/**
 * Verifies a Google Identity Services ID token server-side. Returns the
 * verified email on success, or null on ANY failure (expired token, wrong
 * audience, invalid signature, unverified email, etc.) — callers must
 * treat null as "authentication failed," never fall back to trusting a
 * client-supplied email instead.
 *
 * Never logs the token itself or the raw verification error (which can
 * embed token fragments) — only a generic, secret-free failure signal.
 *
 * Used where the token came out of a server-side code exchange that carries its own `state` (the Gmail connection callback). A token handed to the BROWSER by the sign-in
 * button must use verifyGoogleIdTokenForSignIn, which also checks the nonce.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<{ email: string; name?: string } | null> {
  return verify(idToken, undefined);
}

/**
 * The sign-in button's token: everything verifyGoogleIdToken checks, plus its `nonce` claim must equal the one this browser's binding cookie implies (google-login-binding.ts), so a
 * token obtained somewhere else cannot sign this browser in. No nonce to compare against (no cookie) means the sign-in did not start here: refused before anything is sent to Google.
 */
export async function verifyGoogleIdTokenForSignIn(idToken: string, expectedNonce: string | null | undefined): Promise<{ email: string; name?: string } | null> {
  if (!expectedNonce) return null;
  return verify(idToken, expectedNonce);
}

async function verify(idToken: string, expectedNonce: string | undefined): Promise<{ email: string; name?: string } | null> {
  try {
    const ticket = await getClient().verifyIdToken({
      idToken,
      audience: getGoogleClientId(),
    });
    const payload = ticket.getPayload();
    if (!payload?.email || payload.email_verified !== true) {
      return null;
    }
    if (expectedNonce !== undefined && !nonceMatches(expectedNonce, payload.nonce)) {
      console.warn("[google-auth] ID token nonce did not match this browser's sign-in request");
      return null;
    }
    // `name` is Google's own display name from the same verified token —
    // never security-relevant (only ever used as a display value, e.g. the
    // initial-admin bootstrap's Account.fullName), so an absent/empty value
    // is simply omitted rather than treated as a verification failure.
    return { email: payload.email, name: payload.name || undefined };
  } catch {
    console.warn("[google-auth] ID token verification failed");
    return null;
  }
}
