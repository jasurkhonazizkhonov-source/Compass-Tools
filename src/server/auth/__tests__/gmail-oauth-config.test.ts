import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Regression coverage: getGmailRedirectUri() used to build its base URL
// with a bare `process.env.APP_BASE_URL || "http://localhost:3000"` —
// no Vercel-aware fallback, no warning if genuinely misconfigured in
// production. A Vercel deployment that never sets APP_BASE_URL explicitly
// (relying on Vercel's own auto-injected URL, exactly like every
// customer-facing link already does via resolveBaseUrl()) would silently
// register a localhost redirect_uri with Google, breaking "Connect Gmail"
// for every user with no server-side error to ever find. Now shares
// resolveBaseUrl() with every other base-URL consumer in the app.

// NODE_ENV is intentionally excluded — @types/node marks it readonly, and
// none of these tests exercise resolveBaseUrl()'s production-only warning
// branch (that's covered by company-config's own resolveBaseUrl callers).
const ENV_KEYS = ["APP_BASE_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("getGmailRedirectUri", () => {
  it("uses APP_BASE_URL when explicitly set", async () => {
    process.env.APP_BASE_URL = "https://crm.example.com";
    const { getGmailRedirectUri } = await import("../gmail-oauth-config");
    expect(getGmailRedirectUri()).toBe("https://crm.example.com/api/auth/gmail/callback");
  });

  it("falls back to Vercel's auto-injected production URL when APP_BASE_URL is unset — the exact gap the old bare fallback missed", async () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "compass-tools.vercel.app";
    const { getGmailRedirectUri } = await import("../gmail-oauth-config");
    expect(getGmailRedirectUri()).toBe("https://compass-tools.vercel.app/api/auth/gmail/callback");
  });

  it("falls back to plain localhost only when neither APP_BASE_URL nor any Vercel URL is set", async () => {
    const { getGmailRedirectUri } = await import("../gmail-oauth-config");
    expect(getGmailRedirectUri()).toBe("http://localhost:3000/api/auth/gmail/callback");
  });

  // Pass 36 — real bug found and fixed: APP_BASE_URL="https://example.com/"
  // (trailing slash — an easy copy-paste mistake into Vercel's env-var UI)
  // previously produced a double-slash redirect_uri
  // ("https://example.com//api/auth/gmail/callback") that would never match
  // the single-slash URI actually registered in Google Cloud Console,
  // failing "Connect Gmail" with redirect_uri_mismatch for a purely
  // cosmetic env-var typo.
  it("strips a trailing slash from APP_BASE_URL before building the redirect_uri", async () => {
    process.env.APP_BASE_URL = "https://crm.example.com/";
    const { getGmailRedirectUri } = await import("../gmail-oauth-config");
    expect(getGmailRedirectUri()).toBe("https://crm.example.com/api/auth/gmail/callback");
  });

  it("strips multiple trailing slashes from APP_BASE_URL", async () => {
    process.env.APP_BASE_URL = "https://crm.example.com///";
    const { getGmailRedirectUri } = await import("../gmail-oauth-config");
    expect(getGmailRedirectUri()).toBe("https://crm.example.com/api/auth/gmail/callback");
  });
});
