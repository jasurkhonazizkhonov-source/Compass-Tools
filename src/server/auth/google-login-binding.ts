// Binds a Google ID token to the BROWSER that asked for it (login CSRF / token injection protection).
//
// The sign-in uses Google Identity Services (the "Continue with Google" button): Google hands the browser an ID token, the browser passes it to the signInWithGoogle server
// action, which verifies it server-side. That is not a redirect flow, so there is no OAuth `state` or PKCE to carry; what the flow DOES support is the `nonce` claim: a value the
// page gives Google when it starts, which Google copies into the signed token. Checking it means a token that was obtained somewhere else (a phished or injected credential, a
// token captured from another session) cannot be used to sign THIS browser in, because this browser's own secret is what the nonce was derived from.
//
//   - a random secret ("binding") lives in an HttpOnly, SameSite=Lax cookie that script on the page can never read;
//   - the nonce handed to Google is a one-way hash of it, so the token (which carries the nonce) does not reveal the secret;
//   - the server recomputes the hash from the cookie on every sign-in and requires the token's nonce to equal it.
// The same cookie is reused by every tab of the browser, so two open login tabs do not invalidate each other. It carries no personal data.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { isProductionEnvironment } from "@/lib/env";

export const GOOGLE_BINDING_COOKIE = "compass_google_bind";
const MAX_AGE_SECONDS = 6 * 60 * 60;
const VALID_BINDING = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

/** The nonce for a binding: one-way, so a token that carries it does not give the secret away. */
export function nonceForBinding(binding: string): string {
  return createHash("sha256").update(`compass-google-login-v1:${binding}`).digest("base64url");
}

/** Constant-time comparison of the nonce the token carries with the one this browser's binding implies. */
export function nonceMatches(expected: string | null | undefined, claim: unknown): boolean {
  if (typeof expected !== "string" || expected.length === 0 || typeof claim !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(claim);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The nonce implied by this browser's cookie, or null when there is no (valid) binding yet. Never creates one. */
export async function readBindingNonce(): Promise<string | null> {
  try {
    const value = (await cookies()).get(GOOGLE_BINDING_COOKIE)?.value;
    return value && VALID_BINDING.test(value) ? nonceForBinding(value) : null;
  } catch {
    return null;
  }
}

/** The nonce for this browser; the binding cookie is created (or replaced, when malformed) the first time. */
export async function ensureBindingNonce(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(GOOGLE_BINDING_COOKIE)?.value;
  if (existing && VALID_BINDING.test(existing)) return nonceForBinding(existing);
  const binding = randomBytes(32).toString("base64url");
  jar.set(GOOGLE_BINDING_COOKIE, binding, { httpOnly: true, sameSite: "lax", secure: isProductionEnvironment(), path: "/", maxAge: MAX_AGE_SECONDS });
  return nonceForBinding(binding);
}

/** Forgets the binding after a successful sign-in, so the next sign-in starts with a new secret. */
export async function clearBinding(): Promise<void> {
  try {
    (await cookies()).delete(GOOGLE_BINDING_COOKIE);
  } catch {
    // the session is already established; a leftover binding cookie is harmless (it is only ever a hash input)
  }
}
