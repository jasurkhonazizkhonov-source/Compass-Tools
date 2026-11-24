// Hash-based Content-Security-Policy for the PRE-RENDERED public pages (the marketing pages), run right after `next build` by scripts/build.mjs.
//
// Why: those pages are built once, so no per-request nonce can exist for the inline scripts Next.js writes into them (the hydration data `self.__next_f.push(...)` and the theme
// bootstrap). The base policy therefore had to allow `'unsafe-inline'` for scripts there. But the HTML of a static page does not change between requests, so each inline script can
// be allowed by its SHA-256 instead: any OTHER inline script (an injected one) is refused, and the pages stay static and CDN-cacheable (docs/CSP.md).
//
// What it does: for every pre-rendered page that has an HTML file, it hashes each executable inline <script> and appends a route entry to `.next/routes-manifest.json` (and to the
// copy inside `.next/standalone`, which `output: standalone` made earlier) whose Content-Security-Policy is the base policy with `script-src 'self' <hashes> <the other sources>`
// - without `'unsafe-inline'`. Next.js applies matching header rules in order and a later rule overrides an earlier one for the same header, so the page-specific rule wins.
// 'strict-dynamic' is deliberately NOT used here: it would make browsers ignore 'self', and the parser-inserted <script src> tags of a static page cannot carry a nonce.
//
// Safe by construction: nothing is changed for a page when anything about it is unexpected (no HTML, no base policy found); a failure leaves the base policy in force (the build is
// not failed unless --require is given, which CI may use) and says so. Cloudflare/Vercel builds do not run this (they have their own build scripts): they keep the base policy.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTABLE_TYPES = new Set(["", "text/javascript", "application/javascript", "module"]);

/** SHA-256 CSP source tokens (`'sha256-...'`) of every executable inline <script> in the HTML (data blocks such as application/ld+json are not executed and need none). */
export function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1];
    if (/\ssrc\s*=/i.test(attributes)) continue; // an external script is governed by 'self'
    const type = (/\stype\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1] ?? "").trim().toLowerCase();
    if (!EXECUTABLE_TYPES.has(type)) continue;
    if (match[2].trim() === "") continue;
    hashes.add(`'sha256-${createHash("sha256").update(match[2], "utf8").digest("base64")}'`);
  }
  return [...hashes].sort();
}

/** The base policy with its script-src replaced: 'self', the hashes, and whatever other sources it had - minus 'unsafe-inline' (and 'strict-dynamic' / nonces, which do not apply here). */
export function pagePolicy(baseCsp, hashes) {
  const directives = baseCsp.split("; ");
  const i = directives.findIndex((d) => d.startsWith("script-src "));
  if (i < 0) throw new Error("the base policy has no script-src");
  const others = directives[i]
    .split(" ")
    .slice(1)
    .filter((t) => t !== "'unsafe-inline'" && t !== "'strict-dynamic'" && !t.startsWith("'nonce-") && t !== "'self'" && !t.startsWith("'sha256-"));
  directives[i] = ["script-src", "'self'", ...hashes, ...others].join(" ");
  return directives.join("; ");
}

/** The manifest route entry (source + regex) for one static page path such as /about or /features/leads. */
export function routeEntry(pagePath, policy) {
  const escaped = pagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { source: pagePath, headers: [{ key: "Content-Security-Policy", value: policy }], regex: `^${escaped}(?:/)?$` };
}

const NOT_PAGES = /(^\/(_|api\/))|\.[a-z0-9]+$|^\/(icon|apple-icon|robots\.txt|sitemap\.xml)$/i;

/** Applies the per-page policies to one routes-manifest.json. Returns what it did. */
export function patchRoutesManifest({ manifestPath, serverAppDir, routes }) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const baseRule = manifest.headers?.find((h) => h.source === "/:path*");
  const baseCsp = baseRule?.headers?.find((h) => h.key === "Content-Security-Policy")?.value;
  if (!baseCsp) throw new Error("no base Content-Security-Policy found in " + manifestPath);
  // idempotent: remove entries added by an earlier run
  manifest.headers = manifest.headers.filter((h) => h.source === "/:path*" || !h.headers?.some((x) => x.key === "Content-Security-Policy"));
  const patched = [];
  const skipped = [];
  for (const route of routes) {
    if (NOT_PAGES.test(route)) continue;
    const htmlPath = path.join(serverAppDir, (route === "/" ? "/index" : route) + ".html");
    if (!existsSync(htmlPath)) {
      skipped.push(route);
      continue;
    }
    const hashes = inlineScriptHashes(readFileSync(htmlPath, "utf8"));
    if (hashes.length === 0) {
      skipped.push(route);
      continue;
    }
    manifest.headers.push(routeEntry(route, pagePolicy(baseCsp, hashes)));
    patched.push({ route, hashes: hashes.length });
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { patched, skipped };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const require = process.argv.includes("--require");
  const nextDir = path.join(root, ".next");
  try {
    const prerender = JSON.parse(readFileSync(path.join(nextDir, "prerender-manifest.json"), "utf8"));
    const routes = Object.keys(prerender.routes ?? {});
    const targets = [path.join(nextDir, "routes-manifest.json"), path.join(nextDir, "standalone", ".next", "routes-manifest.json")].filter((p) => existsSync(p));
    if (targets.length === 0) throw new Error("no routes-manifest.json found; was `next build` run?");
    let total = 0;
    for (const manifestPath of targets) {
      const { patched, skipped } = patchRoutesManifest({ manifestPath, serverAppDir: path.join(nextDir, "server", "app"), routes });
      total = patched.length;
      console.log(`[csp] ${path.relative(root, manifestPath)}: hash-based script policy for ${patched.length} pre-rendered page(s)${skipped.length ? ` (left on the base policy: ${skipped.join(", ")})` : ""}`);
    }
    if (require && total === 0) throw new Error("no page was patched");
  } catch (err) {
    console.warn(`[csp] static pages keep the base policy ('unsafe-inline' scripts): ${err instanceof Error ? err.message : String(err)}`);
    if (require) process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
