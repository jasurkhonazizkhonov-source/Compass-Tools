import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { buildBaseCsp, buildNonceCsp, newNonce } from "@/lib/csp";

// Card-handling pages (the customer's card entry under /quote/* and every
// signed-in CRM page) get a strict per-request-nonce script policy; everything
// else keeps the pragmatic base policy. What a CSP does and does not protect:
// it refuses INJECTED inline script and inline event handlers (how a
// cross-site-scripting bug would read a card as it is typed); it does not stop
// a compromised dependency that is already trusted, and style-src still allows
// 'unsafe-inline'.

const findUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { account: { findUnique: (...a: unknown[]) => findUnique(...a) } } }));
beforeEach(() => vi.clearAllMocks());

const req = (path: string, cookie?: string) => new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie: `compass_dev_account=${cookie}` } } : undefined);
const scriptSrc = (csp: string) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"))!;

describe("nonce", () => {
  it("is unpredictable: 128 random bits, base64, unique per call", () => {
    const seen = new Set(Array.from({ length: 500 }, newNonce));
    expect(seen.size).toBe(500);
    for (const n of seen) expect(atob(n).length).toBe(16);
  });
});

describe("policies", () => {
  it("the nonce policy allows only nonce'd scripts (no 'unsafe-inline', no host allow-list, no unsafe-eval in production)", () => {
    const csp = buildNonceCsp("abc123==");
    expect(scriptSrc(csp)).toBe("script-src 'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(scriptSrc(csp)).not.toMatch(/unsafe-inline|unsafe-eval|https:/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(csp).toMatch(/form-action 'self'/);
    expect(scriptSrc(buildNonceCsp("n", true))).toMatch(/unsafe-eval/); // development only
  });

  it("the base policy is unchanged for the routes that cannot carry a nonce", () => {
    expect(scriptSrc(buildBaseCsp())).toBe("script-src 'self' 'unsafe-inline' https://accounts.google.com");
  });

  it("neither policy loads anything from a payment provider or an unexpected third party", () => {
    for (const csp of [buildBaseCsp(), buildNonceCsp("n")]) {
      const hosts = [...new Set(csp.match(/https:\/\/[a-z0-9.-]+/g) ?? [])].sort();
      expect(hosts).toEqual(["https://accounts.google.com", "https://www.googleapis.com"]);
    }
  });
});

describe("proxy applies the nonce policy where card data appears", () => {
  it("the public card-entry and confirmation pages get a fresh nonce CSP on the response and the same nonce forwarded to rendering — without any session gate", async () => {
    const { proxy } = await import("../proxy");
    const a = await proxy(req("/quote/some-token/book"));
    const b = await proxy(req("/quote/some-token/book"));
    expect(findUnique).not.toHaveBeenCalled(); // public: the secure token is the credential
    const cspA = a.headers.get("content-security-policy")!;
    const cspB = b.headers.get("content-security-policy")!;
    expect(scriptSrc(cspA)).toMatch(/'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(cspA).not.toBe(cspB); // fresh per request
    expect(a.headers.get("location")).toBeNull();
    // the request header Next.js parses the nonce from is set to the same policy
    expect(a.headers.get("x-middleware-override-headers")).toMatch(/content-security-policy/i);
    expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(cspA);
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(/'nonce-([^']+)'/.exec(cspA)![1]);
  });

  it("signed-in CRM pages get it too; unauthenticated requests are still redirected and get no page", async () => {
    findUnique.mockResolvedValue({ status: "ACTIVE", role: "ADMIN", sessionCreatedAt: new Date() });
    const { proxy } = await import("../proxy");
    const ok = await proxy(req("/bookings/abc", "valid-looking-token"));
    expect(scriptSrc(ok.headers.get("content-security-policy")!)).toMatch(/'nonce-/);
    const denied = await proxy(req("/bookings/abc"));
    expect(denied.headers.get("location")).toContain("/login");
  });

  it("the proxy matcher covers the public card-entry routes", async () => {
    const { config } = await import("../proxy");
    expect(config.matcher).toContain("/quote/:path*");
  });
});
