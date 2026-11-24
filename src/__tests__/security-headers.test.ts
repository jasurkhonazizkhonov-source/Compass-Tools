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

  it("the framework is not advertised: poweredByHeader is off, and no configured header re-adds X-Powered-By", async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = (await nextConfig.headers!()) as Array<{ headers: Array<{ key: string }> }>;
    expect(rules.flatMap((r) => r.headers.map((h) => h.key.toLowerCase()))).not.toContain("x-powered-by");
  });

  it("turning the framework banner off removes none of the security headers", async () => {
    // The same assertions as the first test, for a page, an API route and an error-ish path: poweredByHeader is independent of headers().
    for (const path of ["/login", "/dashboard", "/api/health", "/does-not-exist"]) {
      const h = await headersFor(path);
      expect(h.get("x-content-type-options"), path).toBe("nosniff");
      expect(h.get("x-frame-options"), path).toBe("DENY");
      expect(h.get("content-security-policy"), path).toMatch(/frame-ancestors 'none'/);
      expect(h.get("strict-transport-security"), path).toBeTruthy();
    }
  });

  it("static assets are not forced to no-store (they stay cacheable)", async () => {
    expect((await headersFor("/_next/static/chunks/app.js")).get("cache-control")).toBeUndefined();
  });
});

describe("browser capability and window isolation headers", () => {
  it("everything the CRM does not use is switched off, and the window policy still lets Google's sign-in popup answer", async () => {
    const h = await headersFor("/anything");
    const pp = h.get("permissions-policy")!;
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb", "serial", "bluetooth", "accelerometer", "gyroscope", "magnetometer", "display-capture", "interest-cohort"]) expect(pp).toContain(`${feature}=()`);
    // same-origin-allow-popups, never plain same-origin: that would sever the link to Google's popup and break sign-in
    expect(h.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
  });
});
