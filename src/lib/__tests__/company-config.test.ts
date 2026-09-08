import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Pass 39 — dedicated coverage for resolveBaseUrl() itself (previously
// only exercised indirectly via gmail-oauth-config.test.ts). Added while
// investigating a real production "Error 400: origin_mismatch" report
// (origin=https://compass-tools-rhj9xf4i1-travel-agency1.vercel.app) to
// prove the application's OWN URL-resolution logic is not the cause: it
// correctly resolves ANY given Vercel deployment URL (including a
// deployment-specific, hash-suffixed one like the reported origin) into a
// valid base URL either way. The actual origin_mismatch is a Google Cloud
// Console configuration gap (that exact origin not yet being in the
// OAuth client's Authorized JavaScript origins) — never something this
// resolution function could fix, since Google Identity Services checks the
// browser's real address bar, not any server-side env var. See
// docs/DEPLOYMENT.md §2a for the full explanation and the corrective
// action (register the deployment's actual origin, and prefer the STABLE
// production alias over a per-deployment URL that changes on every
// deploy).

// NODE_ENV is intentionally excluded — @types/node marks it readonly, and
// none of these tests exercise resolveBaseUrl()'s production-only warning
// branch (matches the same convention already established in
// gmail-oauth-config.test.ts).
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

describe("resolveBaseUrl", () => {
  it("prefers an explicitly configured APP_BASE_URL over any Vercel-provided value", async () => {
    process.env.APP_BASE_URL = "https://crm.example.com";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "should-not-be-used.vercel.app";
    const { resolveBaseUrl } = await import("../company-config");
    expect(resolveBaseUrl()).toBe("https://crm.example.com");
  });

  it("strips a trailing slash from APP_BASE_URL so a base-URL value never accidentally contains a path", async () => {
    process.env.APP_BASE_URL = "https://crm.example.com/";
    const { resolveBaseUrl } = await import("../company-config");
    expect(resolveBaseUrl()).toBe("https://crm.example.com");
    expect(resolveBaseUrl()).not.toContain("/login");
  });

  it("trims and strips a trailing slash from APP_BASE_URL together", async () => {
    process.env.APP_BASE_URL = "  https://crm.example.com/  ";
    const { resolveBaseUrl } = await import("../company-config");
    expect(resolveBaseUrl()).toBe("https://crm.example.com");
  });

  it("falls back to Vercel's STABLE production alias (VERCEL_PROJECT_PRODUCTION_URL) when APP_BASE_URL is unset", async () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "compass-tools-sage.vercel.app";
    const { resolveBaseUrl } = await import("../company-config");
    expect(resolveBaseUrl()).toBe("https://compass-tools-sage.vercel.app");
  });

  // Pass 39 — the exact real-world reported scenario: a genuinely
  // deployment-specific, hash-suffixed Vercel URL (the kind assigned to
  // ONE particular deployment, not the stable production alias). The
  // application must still resolve it into a well-formed base URL without
  // erroring — proving the CODE correctly handles this value either way;
  // it's the Google Cloud Console registration (a value this function has
  // no influence over at all) that must separately be kept in sync with
  // whichever origin real users actually browse to.
  it("resolves a deployment-specific (hash-suffixed) VERCEL_URL into a valid base URL when no stable alias is configured", async () => {
    process.env.VERCEL_URL = "compass-tools-rhj9xf4i1-travel-agency1.vercel.app";
    const { resolveBaseUrl } = await import("../company-config");
    expect(resolveBaseUrl()).toBe("https://compass-tools-rhj9xf4i1-travel-agency1.vercel.app");
  });

  it("prefers the stable VERCEL_PROJECT_PRODUCTION_URL over a deployment-specific VERCEL_URL when both are present", async () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "compass-tools-sage.vercel.app";
    process.env.VERCEL_URL = "compass-tools-rhj9xf4i1-travel-agency1.vercel.app";
    const { resolveBaseUrl } = await import("../company-config");
    expect(resolveBaseUrl()).toBe("https://compass-tools-sage.vercel.app");
  });

  it("never returns a value containing a path like /login regardless of which source it resolved from", async () => {
    for (const [key, value] of [
      ["APP_BASE_URL", "https://crm.example.com"],
      ["VERCEL_PROJECT_PRODUCTION_URL", "compass-tools-sage.vercel.app"],
      ["VERCEL_URL", "compass-tools-rhj9xf4i1-travel-agency1.vercel.app"],
    ] as const) {
      for (const k of ENV_KEYS) delete process.env[k];
      process.env[key] = value;
      const { resolveBaseUrl } = await import("../company-config");
      const result = resolveBaseUrl();
      expect(result).not.toContain("/login");
      expect(result.startsWith("https://")).toBe(true);
    }
  });
});
