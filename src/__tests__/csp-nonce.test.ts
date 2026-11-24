import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildBaseCsp, buildNonceCsp, newNonce, SONNER_STYLE_HASH } from "@/lib/csp";

// Card-handling pages (the customer's card entry under /quote/* and every
// signed-in CRM page) get a strict per-request-nonce script policy; everything
// else keeps the pragmatic base policy. What a CSP does and does not protect:
// it refuses INJECTED inline script and inline event handlers (how a
// cross-site-scripting bug would read a card as it is typed); it does not stop
// a compromised dependency that is already trusted. Style ELEMENTS need the nonce (or, in the base policy, come only from this site); only style ATTRIBUTES stay
// 'unsafe-inline' (style-src-attr), because they cannot carry a nonce.

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

  it("the base policy is unchanged for scripts on the routes that cannot carry a nonce", () => {
    expect(scriptSrc(buildBaseCsp())).toBe("script-src 'self' 'unsafe-inline' https://accounts.google.com");
  });

  it("style ELEMENTS are never 'unsafe-inline' in the base policy or the CRM/card-page policy; style ATTRIBUTES are the only inline-style allowance there, and nothing allows an injected <style> block", () => {
    const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(name + " "));
    const base = buildBaseCsp();
    const nonce = buildNonceCsp("abc123==");
    expect(directive(base, "style-src")).toBe(`style-src 'self' ${SONNER_STYLE_HASH} https://accounts.google.com`);
    expect(directive(nonce, "style-src")).toBe(`style-src 'self' 'nonce-abc123==' ${SONNER_STYLE_HASH}`);
    for (const csp of [base, nonce]) {
      expect(directive(csp, "style-src")).not.toContain("unsafe-inline");
      expect(directive(csp, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
      expect(csp).not.toMatch(/style-src-elem/); // style-src covers elements; no looser elem directive
    }
  });

  it("'unsafe-eval' is development-only on the base policy too: never in production or test, only when dev is requested or NODE_ENV is development", () => {
    const original = process.env.NODE_ENV;
    try {
      for (const env of ["production", "test", undefined]) {
        if (env === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
        else (process.env as Record<string, string | undefined>).NODE_ENV = env;
        expect(buildBaseCsp(), String(env)).not.toContain("unsafe-eval");
        expect(scriptSrc(buildBaseCsp()), String(env)).toBe("script-src 'self' 'unsafe-inline' https://accounts.google.com");
      }
      (process.env as Record<string, string | undefined>).NODE_ENV = "development";
      expect(scriptSrc(buildBaseCsp())).toBe("script-src 'self' 'unsafe-inline' https://accounts.google.com 'unsafe-eval'");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = original;
    }
    expect(scriptSrc(buildBaseCsp(true))).toContain("'unsafe-eval'");
    expect(scriptSrc(buildBaseCsp(false))).not.toContain("unsafe-eval");
    // nothing else about the policy changes with the flag
    expect(buildBaseCsp(true).replace(" 'unsafe-eval'", "")).toBe(buildBaseCsp(false));
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

describe("the one third-party stylesheet that is hash-pinned", () => {
  it("SONNER_STYLE_HASH is the SHA-256 of the stylesheet the installed sonner adds to the page (upgrading sonner fails here, with the new value, instead of leaving toasts unstyled)", () => {
    const source = readFileSync("node_modules/sonner/dist/index.mjs", "utf8");
    const call = /__insertCSS\((".*")\)\s*;?\s*$/m.exec(source);
    expect(call, "sonner no longer calls __insertCSS with one string literal: re-check how it adds its styles").not.toBeNull();
    const css = JSON.parse(call![1]) as string; // a double-quoted literal with only \" and \ escapes
    const hash = `'sha256-${createHash("sha256").update(css, "utf8").digest("base64")}'`;
    expect(hash).toBe(SONNER_STYLE_HASH);
  });
});

describe("the dynamic public pages get the strict policy too", () => {
  it.each(["/", "/access-denied"])("%s: a fresh nonce policy with no 'unsafe-inline' for scripts, and NO session lookup or redirect (the page does its own check)", async (path) => {
    const { proxy, config } = await import("../proxy");
    expect(config.matcher).toContain(path);
    findUnique.mockClear();
    const a = await proxy(req(path));
    const b = await proxy(req(path));
    expect(findUnique).not.toHaveBeenCalled();
    expect(a.headers.get("location")).toBeNull();
    const csp = a.headers.get("content-security-policy")!;
    expect(scriptSrc(csp)).toMatch(/'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(scriptSrc(csp)).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).not.toBe(b.headers.get("content-security-policy"));
    expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  });

  it("the pre-rendered marketing pages are NOT in the matcher (they cannot carry a nonce) - so each of them is still a static file that the build proves with a nonce-free base policy", async () => {
    const { config } = await import("../proxy");
    for (const p of ["/about", "/contact", "/features", "/privacy", "/security", "/terms"]) expect(config.matcher.some((m) => m === p || m.startsWith(p + "/"))).toBe(false);
  });
});

describe("the sign-in page gets the strict policy too", () => {
  it("/login is in the matcher, is public (no session lookup, never redirected to itself), and its script-src has a per-request nonce and NO 'unsafe-inline'", async () => {
    const { proxy, config } = await import("../proxy");
    expect(config.matcher).toContain("/login");
    findUnique.mockClear();
    const a = await proxy(req("/login"));
    const b = await proxy(req("/login"));
    expect(findUnique).not.toHaveBeenCalled();
    expect(a.headers.get("location")).toBeNull();
    const csp = a.headers.get("content-security-policy")!;
    expect(scriptSrc(csp)).toMatch(/'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(scriptSrc(csp)).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).not.toBe(b.headers.get("content-security-policy")); // fresh per request
    expect(a.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
  });

  it("only the sign-in page is allowed Google's stylesheet: it is on style-src of /login and nowhere else in the nonce policy", async () => {
    const { proxy } = await import("../proxy");
    const styleSrc = (csp: string) => csp.split("; ").find((d) => d.startsWith("style-src "))!;
    const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)![1];
    const login = (await proxy(req("/login"))).headers.get("content-security-policy")!;
    // No 'unsafe-inline' even here: Google's script copies the nonce of its own tag onto the inline <style> it adds (the tag gets this request's nonce, see google-sign-in-button.test).
    expect(styleSrc(login)).toBe(`style-src 'self' 'nonce-${nonceOf(login)}' ${SONNER_STYLE_HASH} https://accounts.google.com`);
    expect(styleSrc(login)).not.toContain("unsafe-inline");
    expect(login).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/); // and the SCRIPT policy of that page is still strict
    expect(styleSrc(buildNonceCsp("n"))).toBe(`style-src 'self' 'nonce-n' ${SONNER_STYLE_HASH}`);
    const quote = (await proxy(req("/quote/x/book"))).headers.get("content-security-policy")!;
    expect(styleSrc(quote)).toBe(`style-src 'self' 'nonce-${nonceOf(quote)}' ${SONNER_STYLE_HASH}`);
    expect(styleSrc(quote)).not.toContain("accounts.google.com"); // Google's stylesheet is for the sign-in page only
    // and the policy still loads nothing from anywhere unexpected
    const hosts = [...new Set(buildNonceCsp("n", false, { googleSignIn: true }).match(/https:\/\/[a-z0-9.-]+/g) ?? [])].sort();
    expect(hosts).toEqual(["https://accounts.google.com", "https://www.googleapis.com"]);
  });

  it("the policy keeps its anti-clickjacking, anti-injection directives", () => {
    const csp = buildNonceCsp("n", false, { googleSignIn: true });
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-src https://accounts.google.com"]) expect(csp).toContain(d);
  });
});
