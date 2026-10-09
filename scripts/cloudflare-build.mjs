// Build entry point for Cloudflare Workers Builds / local preview:  node scripts/cloudflare-build.mjs
//
// Runs `opennextjs-cloudflare build` (which itself runs `npm run build` = `next build`, then bundles the Worker into .open-next/).
//
// The one thing it adds: the statically generated public pages (canonical URLs, sitemap, Open Graph) bake the site's origin in AT BUILD
// TIME from APP_BASE_URL. A Cloudflare build has no VERCEL_* variables, so without APP_BASE_URL the origin would silently fall back to
// http://localhost:3000. When APP_BASE_URL is not already set (e.g. as a Workers Builds "build variable"), this script takes it from
// the non-secret `vars.APP_BASE_URL` in wrangler.jsonc, so build time and runtime always agree. An explicit APP_BASE_URL always wins.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.APP_BASE_URL?.trim()) {
  const wrangler = readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
  const m = /"APP_BASE_URL"\s*:\s*"(https:\/\/[^"]+)"/.exec(wrangler);
  if (!m) {
    console.error("APP_BASE_URL is not set and wrangler.jsonc has no https vars.APP_BASE_URL — refusing to build with a localhost origin.");
    process.exit(1);
  }
  process.env.APP_BASE_URL = m[1];
}
console.log(`[cloudflare-build] APP_BASE_URL=${process.env.APP_BASE_URL}`);
// Tells next.config.ts this is a Workers build (stubs the native `sharp` addon, which a Worker cannot load).
process.env.CLOUDFLARE_BUILD = "1";

const bin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "opennextjs-cloudflare.cmd" : "opennextjs-cloudflare");
const result = spawnSync(bin, ["build", ...process.argv.slice(2)], { stdio: "inherit", cwd: root, env: process.env, shell: process.platform === "win32" });
process.exit(result.status ?? 1);
