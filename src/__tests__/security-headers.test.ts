import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

// The response headers the app promises browsers and CDNs. Only claims that
// are actually true of the header are tested: e.g. frame-ancestors/X-Frame-
// Options stop the app being embedded in another site (clickjacking); they do
// not protect against script injection. 'unsafe-inline' remains in script-src
// because Next.js hydration needs it (no nonce plumbing) — a known residual
// risk documented in docs/CARD_VAULT_SECURITY.md.

async function headersFor(path: string) {
  const rules = (await nextConfig.headers!()) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  const matching = rules.filter((r) => {
    // Next's "/x/:path*" matches "/x" and everything beneath it.
    const re = new RegExp("^" + r.source.replace(/\/:path\*/g, "(?:/.*)?") + "$");
    return re.test(path);
  });
  const out = new Map<string, string>();
  for (const rule of matching) for (const h of rule.headers) out.set(h.key.toLowerCase(), h.value);
  return out;
}

describe("security headers", () => {
  it("every route gets CSP with frame-ancestors none, nosniff, referrer policy, X-Frame-Options and HSTS", async () => {
    const h = await headersFor("/anything");
    expect(h.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    expect(h.get("content-security-policy")).toMatch(/object-src 'none'/);
    expect(h.get("content-security-policy")).toMatch(/form-action 'self'/);
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("strict-transport-security")).toMatch(/^max-age=\d{7,}$/);
    expect(h.get("strict-transport-security")).not.toMatch(/preload|includeSubDomains/);
  });

  it("the CSP loads nothing from any payment provider or unexpected third party", async () => {
    const csp = (await headersFor("/x")).get("content-security-policy")!;
    const hosts = csp.match(/https:\/\/[a-z0-9.-]+/g) ?? [];
    expect([...new Set(hosts)].sort()).toEqual(["https://accounts.google.com", "https://www.googleapis.com"]);
  });

  it.each(["/quote/abc/book", "/quote/abc/confirmation", "/bookings/xyz", "/contacts/xyz", "/users", "/system-health", "/api/health"])(
    "%s is never stored by a browser, proxy or CDN",
    async (path) => {
      const cc = (await headersFor(path)).get("cache-control")!;
      expect(cc).toMatch(/no-store/);
      expect(cc).toMatch(/private/);
    }
  );

  it("static assets are not forced to no-store (they stay cacheable)", async () => {
    expect((await headersFor("/_next/static/chunks/app.js")).get("cache-control")).toBeUndefined();
  });
});
