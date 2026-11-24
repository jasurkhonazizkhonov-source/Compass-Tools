// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildBaseCsp } from "@/lib/csp";
import { inlineScriptHashes, pagePolicy, patchRoutesManifest, routeEntry } from "../../scripts/static-page-csp.mjs";

const sha = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

describe("hash-based script policy for pre-rendered pages", () => {
  const html = `<html><head>
    <script src="/_next/static/a.js" async></script>
    <script>self.__next_f=self.__next_f||[]</script>
    <script id="theme-init">(function(){document.documentElement.className="dark"})()</script>
    <script type="application/ld+json">{"@context":"https://schema.org"}</script>
    <script>self.__next_f=self.__next_f||[]</script>
    <script type="module">import("/x.js")</script>
    <script>   </script>
  </head><body></body></html>`;

  it("hashes each executable inline script exactly once (same text twice = one hash), and nothing else: not external scripts, not data blocks, not empty ones", () => {
    expect(inlineScriptHashes(html)).toEqual(
      [sha("self.__next_f=self.__next_f||[]"), sha('(function(){document.documentElement.className="dark"})()'), sha('import("/x.js")')].sort()
    );
  });

  it("the hash covers the exact bytes of the script (a different character is a different hash, so an edited or injected script does not match)", () => {
    expect(inlineScriptHashes("<script>a()</script>")).not.toEqual(inlineScriptHashes("<script>a() </script>"));
  });

  it("the page policy is the base policy with script-src = 'self' + hashes + the other sources - and NO 'unsafe-inline', no 'strict-dynamic', no nonce", () => {
    const base = buildBaseCsp(false);
    expect(base).toContain("script-src 'self' 'unsafe-inline' https://accounts.google.com");
    const policy: string = pagePolicy(base, ["'sha256-AAA='", "'sha256-BBB='"]);
    expect(policy).toContain("script-src 'self' 'sha256-AAA=' 'sha256-BBB=' https://accounts.google.com");
    const scriptSrc = policy.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).not.toMatch(/unsafe-inline|strict-dynamic|nonce-|unsafe-eval/);
    // every other directive is exactly the base policy's
    expect(policy.split("; ").filter((d) => !d.startsWith("script-src"))).toEqual(base.split("; ").filter((d) => !d.startsWith("script-src")));
  });

  it("a development base policy keeps its 'unsafe-eval' out of the production page policy only when it was never there", () => {
    expect(pagePolicy(buildBaseCsp(true), ["'sha256-AAA='"])).toContain("'unsafe-eval'"); // the script copies what the build gave it; production builds never have it
    expect(pagePolicy(buildBaseCsp(false), ["'sha256-AAA='"])).not.toContain("'unsafe-eval'");
    expect(() => pagePolicy("default-src 'self'", [])).toThrow(/no script-src/);
  });

  it("the route entry matches exactly that page (with or without a trailing slash), nothing else", () => {
    const entry = routeEntry("/features/leads", "p");
    expect(entry.source).toBe("/features/leads");
    const re = new RegExp(entry.regex);
    expect(re.test("/features/leads")).toBe(true);
    expect(re.test("/features/leads/")).toBe(true);
    expect(re.test("/features/leads/extra")).toBe(false);
    expect(re.test("/features")).toBe(false);
    expect(entry.headers).toEqual([{ key: "Content-Security-Policy", value: "p" }]);
  });

  it("patches a routes manifest: pages with HTML get their own rule AFTER the base rule, others are left alone, assets are never touched, and a second run changes nothing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "csp-"));
    const app = path.join(dir, "server", "app");
    mkdirSync(path.join(app, "features"), { recursive: true });
    writeFileSync(path.join(app, "about.html"), "<script>one()</script>");
    writeFileSync(path.join(app, "features", "leads.html"), "<script>two()</script>");
    writeFileSync(path.join(app, "empty.html"), "<p>no scripts</p>");
    const manifestPath = path.join(dir, "routes-manifest.json");
    const base = buildBaseCsp(false);
    writeFileSync(manifestPath, JSON.stringify({ headers: [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: base }] }, { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] }] }));
    const routes = ["/about", "/features/leads", "/empty", "/missing", "/icon", "/robots.txt", "/_not-found"];

    const first = patchRoutesManifest({ manifestPath, serverAppDir: app, routes });
    expect(first.patched.map((p: { route: string }) => p.route)).toEqual(["/about", "/features/leads"]);
    expect(first.skipped).toEqual(["/empty", "/missing"]);
    const after = JSON.parse(readFileSync(manifestPath, "utf8")) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
    expect(after.headers.map((h) => h.source)).toEqual(["/:path*", "/api/:path*", "/about", "/features/leads"]); // the base rule first, page rules after it
    expect(after.headers[0].headers[0].value).toBe(base); // the base policy itself is untouched
    expect(after.headers[2].headers[0].value).toContain(sha("one()"));
    expect(after.headers[3].headers[0].value).toContain(sha("two()"));

    patchRoutesManifest({ manifestPath, serverAppDir: app, routes });
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual(after); // idempotent
  });

  it("without a base policy in the manifest it refuses (the build script then leaves the base policy in force)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "csp-"));
    const manifestPath = path.join(dir, "routes-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ headers: [] }));
    expect(() => patchRoutesManifest({ manifestPath, serverAppDir: dir, routes: ["/about"] })).toThrow(/no base Content-Security-Policy/);
  });
});
