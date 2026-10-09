// `npm run build` — the project's default build.
//
//  * Everywhere else (local, CI, Vercel's own `vercel-build` is separate and never calls this): plain `next build`, unchanged.
//  * Inside Cloudflare Workers Builds (it sets WORKERS_CI): the full OpenNext Cloudflare build (scripts/cloudflare-build.mjs).
//
// Why: Workers Builds runs the project's "build" script and then `npx wrangler deploy`, which delegates to
// `opennextjs-cloudflare deploy`. That step needs the output of `opennextjs-cloudflare build` (.open-next/), and a plain
// `next build` does not produce it ("Could not find compiled Open Next config, did you run the build command?").
// Switching on WORKERS_CI makes the dashboard's default build command work without a manual setting. Setting the Build command to
// `npm run cf:build` is equivalent and remains the explicit, preferred form (docs/CLOUDFLARE_DEPLOYMENT.md).
//
// No recursion: the adapter's own inner Next build is `npx next build` (open-next.config.ts `buildCommand`), not `npm run build`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workersBuild = !!process.env.WORKERS_CI && !["0", "false"].includes(process.env.WORKERS_CI.toLowerCase());

const result = workersBuild
  ? (console.log("[build] Cloudflare Workers Builds detected (WORKERS_CI) — running the OpenNext Cloudflare build."),
    spawnSync(process.execPath, [path.join(root, "scripts", "cloudflare-build.mjs")], { stdio: "inherit", cwd: root, env: process.env }))
  : spawnSync("npx next build", { stdio: "inherit", cwd: root, env: process.env, shell: true });

process.exit(result.status ?? 1);
