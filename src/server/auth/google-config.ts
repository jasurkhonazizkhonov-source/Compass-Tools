// Single source of truth for Google OAuth credential access. Deliberately
// under src/server/ (never importable from a "use client" file) so the
// client secret can't end up in a browser bundle by accident. Every place
// that needs a Google credential reads it through here — never
// process.env.GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET directly elsewhere —
// so replacing these credentials later means editing .env only.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured — set it in .env`);
  }
  return value;
}

/** Not a secret — Google's Identity Services button needs this in the
 * browser, and the backend uses the same value as the ID token's expected
 * audience. */
export function getGoogleClientId(): string {
  return requireEnv("GOOGLE_CLIENT_ID");
}

/** Server-only. Not used by the current ID-token verification flow
 * (Google Identity Services doesn't require it), but kept centralized here
 * — never read directly from process.env elsewhere — so a future
 * authorization-code/Gmail-scope flow can use it without scattering the
 * credential across new files. */
export function getGoogleClientSecret(): string {
  return requireEnv("GOOGLE_CLIENT_SECRET");
}
