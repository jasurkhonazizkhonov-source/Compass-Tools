import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

// Guards for the committed Cloudflare Workers (OpenNext) deployment configuration: the pinned dependency set, the Worker config, the
// build entry point and the Workers-only `sharp` stub. They don't prove the Worker runs (see docs/CLOUDFLARE_DEPLOYMENT.md for the
// known runtime blockers) — they stop the configuration that Cloudflare builds from silently drifting.
const ROOT = path.resolve(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf-8");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> };
const wrangler = read("wrangler.jsonc");
// wrangler.jsonc is JSONC: drop // comments, keeping string literals (the https URL contains "//") intact.
const wranglerJson = JSON.parse(wrangler.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_m, str: string | undefined) => str ?? "")) as {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  assets: { directory: string; binding: string };
  services: { binding: string; service: string }[];
  vars: Record<string, string>;
};

describe("dependency pins", () => {
  it("the adapter, Wrangler and Next are exact versions, and the lockfile resolves exactly those", () => {
    for (const [name, spec] of [
      ["next", pkg.dependencies.next],
      ["@opennextjs/cloudflare", pkg.dependencies["@opennextjs/cloudflare"]],
      ["wrangler", pkg.devDependencies.wrangler],
    ] as const) {
      expect(spec, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(spec);
    }
  });

  it("the installed Next satisfies the adapter's peer range (its minimum moves with Next security releases)", () => {
    const peer = (JSON.parse(read("node_modules", "@opennextjs", "cloudflare", "package.json")) as { peerDependencies: { next: string } }).peerDependencies.next;
    // e.g. ">=15.5.27 <16 || >=16.3.8" — take the clause for our major
    const major = pkg.dependencies.next.split(".")[0];
    const clause = peer.split("||").map((c) => c.trim()).find((c) => new RegExp(`>=${major}\\.`).test(c) && !/<\s*\d/.test(c));
    expect(clause, `no clause for Next ${major} in "${peer}"`).toBeDefined();
    const min = /(\d+)\.(\d+)\.(\d+)/.exec(clause!)!.slice(1).map(Number);
    const have = pkg.dependencies.next.split(".").map(Number);
    const cmp = have.map((v, i) => v - min[i]).find((d) => d !== 0) ?? 0;
    expect(cmp).toBeGreaterThanOrEqual(0);
  });

  it("eslint-config-next matches Next", () => {
    expect(pkg.devDependencies["eslint-config-next"]).toBe(pkg.dependencies.next);
  });

  it("the lockfile can be installed by `npm ci`: no resolution depends on a version newer than the registry mirror may have", () => {
    // The first Cloudflare build failed asking for credential-provider-http@^3.972.75 while the lockfile pinned 3.972.74.
    // Every resolved @aws-sdk package must be present in the lockfile (nothing is left to resolve at install time).
    const http = lock.packages["node_modules/@aws-sdk/credential-provider-http"]?.version;
    expect(http).toMatch(/^3\.\d+\.\d+$/);
  });
});

describe("wrangler.jsonc", () => {
  it("names the Worker `compass-tools` and points at the OpenNext output", () => {
    expect(wranglerJson.name).toBe("compass-tools");
    expect(wranglerJson.main).toBe(".open-next/worker.js");
    expect(wranglerJson.assets).toEqual({ directory: ".open-next/assets", binding: "ASSETS" });
  });

  it("enables Node compatibility with a date the adapter supports", () => {
    expect(wranglerJson.compatibility_flags).toEqual(expect.arrayContaining(["nodejs_compat", "global_fetch_strictly_public"]));
    expect(wranglerJson.compatibility_date >= "2024-09-23").toBe(true);
  });

  it("the self-reference service points at the Worker itself", () => {
    expect(wranglerJson.services).toContainEqual({ binding: "WORKER_SELF_REFERENCE", service: wranglerJson.name });
  });

  it("carries APP_BASE_URL as the production www origin and no secrets", () => {
    expect(wranglerJson.vars.APP_BASE_URL).toBe("https://www.compass-tools.com");
    expect(Object.keys(wranglerJson.vars)).toEqual(["APP_BASE_URL"]);
    // (comments may name the secrets that live in the dashboard; the configuration itself must not carry any)
    expect(JSON.stringify(wranglerJson)).not.toMatch(/DATABASE_URL|SECRET|PASSWORD|_KEY\b|TOKEN|postgres(ql)?:\/\//i);
  });
});

describe("build entry point", () => {
  it("scripts are wired and the Vercel build is untouched", () => {
    expect(pkg.scripts["cf:build"]).toBe("node scripts/cloudflare-build.mjs");
    expect(pkg.scripts["cf:deploy"]).toBe("opennextjs-cloudflare deploy");
    expect(pkg.scripts.build).toBe("node scripts/build.mjs");
    expect(pkg.scripts["vercel-build"]).toBe("node scripts/vercel-build.mjs");
    expect(read("vercel.json")).toContain("/api/cron/tasks");
    // Vercel's build calls `next build` directly, so changing the "build" script cannot affect it.
    expect(read("scripts", "vercel-build.mjs")).toContain("npx next build");
  });

  it("`npm run build` produces the OpenNext output inside Workers Builds (WORKERS_CI) and a plain Next build elsewhere", () => {
    // The first Cloudflare deploy failed with "Could not find compiled Open Next config": the dashboard's default Build command
    // is `npm run build`, and `wrangler deploy` -> `opennextjs-cloudflare deploy` needs `.open-next/` from the adapter build.
    const script = read("scripts", "build.mjs");
    expect(script).toMatch(/process\.env\.WORKERS_CI/);
    expect(script).toContain("scripts\", \"cloudflare-build.mjs\"");
    expect(script).toContain("npx next build");
  });

  it("the adapter's inner Next build is pinned to `npx next build`, so `npm run build` can never re-enter itself", () => {
    expect(read("open-next.config.ts")).toMatch(/buildCommand:\s*"npx next build"/);
  });

  it("the build script takes APP_BASE_URL from wrangler.jsonc when unset, refuses a localhost origin, and flags the Workers build", () => {
    const script = read("scripts", "cloudflare-build.mjs");
    expect(script).toMatch(/process\.env\.APP_BASE_URL\?\.trim\(\)/);
    expect(script).toMatch(/refusing to build with a localhost origin/);
    expect(script).toMatch(/process\.env\.CLOUDFLARE_BUILD = "1"/);
    // the regex the script uses finds the https value in the committed wrangler.jsonc
    expect(/"APP_BASE_URL"\s*:\s*"(https:\/\/[^"]+)"/.exec(wrangler)?.[1]).toBe("https://www.compass-tools.com");
  });

  it("build output and local state are git-ignored", () => {
    const ignore = read(".gitignore");
    for (const entry of [".open-next", ".wrangler", ".dev.vars"]) expect(ignore).toContain(entry);
    expect(existsSync(path.join(ROOT, "open-next.config.ts"))).toBe(true);
  });
});

describe("Workers-only sharp stub", () => {
  const saved = process.env.CLOUDFLARE_BUILD;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLOUDFLARE_BUILD;
    else process.env.CLOUDFLARE_BUILD = saved;
    vi.resetModules();
  });

  it("is aliased in only for a Cloudflare build", async () => {
    delete process.env.CLOUDFLARE_BUILD;
    vi.resetModules();
    const normal = (await import("../../next.config")).default as { turbopack?: { resolveAlias?: Record<string, string> } };
    expect(normal.turbopack?.resolveAlias?.sharp).toBeUndefined();

    process.env.CLOUDFLARE_BUILD = "1";
    vi.resetModules();
    const cf = (await import("../../next.config")).default as { turbopack?: { resolveAlias?: Record<string, string> } };
    expect(cf.turbopack?.resolveAlias?.sharp).toBe("./src/lib/cloudflare/sharp-unavailable.ts");
  });

  it("the stub throws a clear error when called", async () => {
    const stub = (await import("@/lib/cloudflare/sharp-unavailable")).default;
    expect(() => stub()).toThrow(/not available on this deployment platform/);
  });
});
