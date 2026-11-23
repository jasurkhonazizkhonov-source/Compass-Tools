import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Guards for the dependency advisories fixed on 2026-11-22 (docs/DEPENDENCY_AUDIT_2026-11-22.md). `npm audit` in CI is report-only, so these run in the REQUIRED unit job: they fail if
// the lockfile ever resolves a copy inside a vulnerable range again (for example after someone drops the overrides, or a parent package re-pins an old version).
// Offline: reads package.json and package-lock.json only. The ranges are the advisories' own:
//   effect   <= 3.22.0            GHSA-7589-6fvf-x4pw  (ReDoS in Schema.TemplateLiteral)   - pulled in by Prisma's config loader (@prisma/config pins an exact old version)
//   glob     >= 9.0.0 <= 14.0.1   GHSA-3g3m-2fjr-6pw4  (AbortSignal cancellation bypass)   - pulled in by the Cloudflare adapter
//   minimatch>= 7.0.0 <  11.0.1   GHSA-g3hv-75wg-m249  (DoS via globparts amplification)    - pulled in by glob and by ts-morph (shadcn CLI)

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { overrides?: Record<string, unknown> };
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; dev?: boolean }> };

type V = [number, number, number];
const parse = (v: string): V => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`unparseable version ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const inRange = (version: string, min: V | null, maxInclusive: V | null, maxExclusive: V | null = null) => {
  const v = parse(version);
  if (min && cmp(v, min) < 0) return false;
  if (maxInclusive && cmp(v, maxInclusive) > 0) return false;
  if (maxExclusive && cmp(v, maxExclusive) >= 0) return false;
  return true;
};
const copiesOf = (name: string) =>
  Object.entries(lock.packages)
    .filter(([p, info]) => p.endsWith(`node_modules/${name}`) && typeof info.version === "string")
    .map(([p, info]) => ({ path: p, version: info.version as string }));

describe("the overrides that make the advisories fixable are in place", () => {
  it("effect is pinned to a patched release (Prisma's config loader pins its own exact old one, so only an override reaches the fix)", () => {
    expect(pkg.overrides?.effect).toBe("3.22.5");
  });
  it("glob is raised only for the Cloudflare adapter, and ts-morph only for the shadcn CLI (scoped: nothing else is moved)", () => {
    expect(pkg.overrides?.["@opennextjs/cloudflare"]).toEqual({ glob: "14.0.6" });
    expect(pkg.overrides?.shadcn).toEqual({ "ts-morph": "28.0.0" });
    expect(Object.keys(pkg.overrides ?? {}).sort()).toEqual(["@opennextjs/cloudflare", "effect", "shadcn"]);
  });
});

describe("the lockfile resolves no copy inside a vulnerable range", () => {
  it("effect: every copy is newer than 3.22.0", () => {
    const copies = copiesOf("effect");
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) expect(inRange(c.version, null, [3, 22, 0]), `${c.path}@${c.version}`).toBe(false);
  });
  it("glob: no copy from 9.0.0 through 14.0.1", () => {
    const copies = copiesOf("glob");
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) expect(inRange(c.version, [9, 0, 0], [14, 0, 1]), `${c.path}@${c.version}`).toBe(false);
  });
  it("minimatch: no copy from 7.0.0 up to (not including) 11.0.1 (the legacy 3.x copy used only by ESLint's own plugins is outside the range)", () => {
    const copies = copiesOf("minimatch");
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) expect(inRange(c.version, [7, 0, 0], null, [11, 0, 1]), `${c.path}@${c.version}`).toBe(false);
  });
});
