# Dependency advisory audit and remediation - 2026-11-22

Scope: `compass-tools-updated`, the actual `package-lock.json`. Tool: `npm audit` (read-only; the registry advisory database), `npm ls` for dependency paths. **No `npm audit fix --force`, no major framework upgrade, no `package.json` range change.** The raw audit JSON files are kept outside the repository next to the audit notes (`F:\Claude Workspace\audit-2026-11-22\npm-audit-*.json`); this document is the human-readable record. Nothing here is a claim that the project is "security-clean": it is the list of what the registry reports, what was changed, and what was left and why.

## 0. Second pass (2026-11-22, after release `75df7b7`): all nine advisories are fixed - `npm audit` reports 0 (0 critical, 0 high, 0 moderate)

The nine advisories were three ROOT advisories and their propagation. Each root had a published, stable, patched release; what stopped `npm audit fix` was that the parent packages pin or cap the old version. Three **scoped `overrides`** in `package.json` reach the fixes; nothing was upgraded across the tree, `--force` was not used, no release candidate or prerelease is involved.

| Root advisory | Vulnerable | Fixed in (stable) | Why the parent could not take it | Override | Effect on the nine |
|---|---|---|---|---|---|
| GHSA-7589-6fvf-x4pw `effect`: ReDoS in `Schema.TemplateLiteral` | <= 3.22.0 | **3.22.5** (same 3.x series; installed was 3.20.0) | `@prisma/config` (even the newest stable 7.10.1) pins the exact version `3.20.0`; Prisma's only newer line is `8.0.0-rc.34`, a release candidate | `"effect": "3.22.5"` | clears `effect`, `@prisma/config`, `prisma` (the 3 high) |
| GHSA-3g3m-2fjr-6pw4 `glob`: AbortSignal cancellation bypass | 9.0.0 - 14.0.1 | **14.0.6** (installed was 13.0.7) | `@opennextjs/cloudflare` (newest 1.20.18) requires `glob ^13` | `"@opennextjs/cloudflare": { "glob": "14.0.6" }` | clears `glob`, `@opennextjs/cloudflare` |
| GHSA-g3hv-75wg-m249 `minimatch`: DoS through globparts amplification | 7.0.0 - 11.0.0 | **11.0.1+** (installed 10.2.6; no 10.x backport exists) | `glob 13` and `@ts-morph/common 0.27` require `minimatch ^10`; `shadcn` (newest 4.23.0) requires `ts-morph ^26` | glob 14 brings `minimatch ^11`; `"shadcn": { "ts-morph": "28.0.0" }` brings `@ts-morph/common 0.29.1` (`minimatch ^11`) | clears `minimatch`, `@ts-morph/common`, `ts-morph`, `shadcn` |

**Is it a breaking change?** `glob` 14, `minimatch` 11 (both ESM-only) and `ts-morph` 28 are major versions for the two CLI tools that use them, and neither tool's maintainer has adopted them yet, so this combination is not one their authors tested. It was therefore **exercised, not assumed**, with the project's own tools (all passed): `npm ci` from the new lockfile; `prisma validate`, `prisma generate` and `prisma migrate diff` (each loads `prisma.config.ts` through `effect 3.22.5`); the unit suite and the production build; `ts-morph` parsing real project files through its glob (so through minimatch 11); the `shadcn` CLI starting; and the exact `glob` / `globSync` calls (same patterns and options) that `@opennextjs/cloudflare` makes, run with glob 14 against this project's real `.next` output (68 trace files, 384 manifests found). **Not exercised end-to-end:** a full `npm run cf:build` Workers build, and `shadcn add` (it needs the component registry over the network). Those two are developer / Cloudflare-Workers tooling that is not part of the Docker image or the VPS deployment; if either misbehaves the override can be removed without touching application code.

**Reachability (unchanged from section 3):** none of the nine ran in the production image (the runner stage contains only the traced standalone server); they are build-time or developer tools. They were fixed anyway because `npm audit` cannot tell an exposure from a presence, and a clean result is easier to keep honest than an explained exception.

**Guard:** `src/__tests__/dependency-advisory-guards.test.ts` runs in the required unit job (the CI `npm audit` step is report-only) and fails if the overrides disappear or the lockfile resolves any copy inside a vulnerable range again. **Revisit** the three overrides when Prisma, `@opennextjs/cloudflare` and `shadcn` ship releases that carry these versions themselves, and remove them then.

The sections below are the earlier history and are kept for the record; section 3's "what remains" is superseded by this section.

## 1. Result

| | Critical | High | Moderate | Total |
|---|---|---|---|---|
| Before (lockfile at commit `2849a58`) | 1 | 19 | 18 | **38** |
| After the targeted in-range updates below (release `a89f5ea`) | **0** | **8** | **6** | **14** |
| After the two same-major tooling updates of the release-branch consolidation (section 2, last two rows) | **0** | **3** | **6** | **9** |

Method: the packages named in each advisory were updated **within the version ranges their dependents already allow** (`npm update <names>`), in two steps, with the full test suite, type-check, lint, `prisma validate` and the production build repeated after the last step. `package.json` ranges are unchanged by that step; its only change is the install-script allow-list (`allowScripts`), whose keys name exact Prisma versions (`@prisma/engines@7.10.1`, `prisma@7.10.1`) - without that change a clean `npm ci` would silently skip Prisma's install scripts. The consolidation step changed two **exact pins** inside their existing major version (`wrangler` 4.149.0 -> 4.166.0 and `@opennextjs/cloudflare` 1.20.10 -> 1.20.18), after checking in the registry that the fixed versions exist and that nothing in the repository's tests or scripts depends on the old ones; a major upgrade, an `overrides` entry and `npm audit fix --force` were all deliberately not used.

## 2. What was updated (installed version after -> advisory addressed)

| Package | Was | Now | Role in this project | Advisory (summary) |
|---|---|---|---|---|
| `proxy-addr` | 2.0.7 | 2.0.8 | transitive via `@opennextjs/cloudflare` -> express (Cloudflare build tooling) | **critical**: IP spoofing via IPv4-mapped IPv6 trust subnet |
| `qs` | 6.15.3 | 6.17.1 | same chain (express) | array-limit bypass, DoS |
| `body-parser` | 2.3.0 | 2.4.0 | same chain | high: DoS via trailing bytes after a compressed body |
| `fast-uri` | 3.1.5 | 3.1.9 | `@hookform/resolvers` -> `ajv` | high: host confusion / SSRF in URI parsing |
| `ip-address` | 10.5.0 | 10.7.6 | transitive | SSRF classification errors |
| `js-yaml` | 4.3.1 | 4.3.2 | `eslint`, `shadcn` | high: CPU use via merge keys |
| `systeminformation` | 5.33.1 | 5.33.23 | `shadcn` -> `@dotenvx` | high: path traversal, prototype pollution |
| `postcss-selector-parser` | 7.1.5 | 7.2.1 | tailwind tooling | quadratic CPU |
| `vite` / `vitest` / `@vitest/*` | 8.2.1 / 4.1.10 | 8.3.8 / 4.1.12 | test tooling | high (vite dev server), moderate (vitest mock path traversal) |
| `shadcn` | 4.18.0 | 4.23.0 | component CLI (listed under `dependencies`, never imported by the app) | removes `hono`, `@modelcontextprotocol/sdk`, the nested old `zod` and `express-rate-limit` from the tree |
| `typescript-eslint` | 8.67.0 | 8.73.0 | lint tooling | moderate |
| `prisma`, `@prisma/client`, `@prisma/adapter-pg` | 7.9.1 | **7.10.1** | CLI (migrations, generate) + the runtime client and PostgreSQL driver adapter | `mysql2` (3.15.3 -> 3.24.4: auth-plugin downgrade, decompression bomb) and `deepmerge-ts` (-> 8.0.2: stack exhaustion), both pulled in by the Prisma CLI |
| `undici` (jsdom copy, shadcn copy, top level) | various | 7.30.2 / 8.13.1 | test tooling / CLI | high: WebSocket DoS |
| `brace-expansion`, `glob`, `minimatch`, `picomatch` | various | patched in-range copies | tooling | high/moderate: quadratic CPU, CLI command injection |
| `wrangler` (exact pin, `devDependencies`) | 4.149.0 | **4.166.0** | Cloudflare Workers CLI (`cf:dry-run`); not part of the Docker image | removes `miniflare` (moderate) and its `undici` 7.0-7.30.0 copy (high: eight advisories - EventSource DoS, SRI bypass, cache poisoning, TLS options dropped, ...). `npx wrangler --version` runs; `cloudflare-config.test.ts` passes |
| `@opennextjs/cloudflare` (exact pin, `dependencies`) | 1.20.10 | **1.20.18** | Cloudflare Workers build tool; not part of the Docker image | its `@opennextjs/aws` 4.1.9-4.1.15 (high) and `@node-minify/core` (high) copies, and the glob CLI command-injection advisory (GHSA-5j98-mcp5-4vw2). `npx opennextjs-cloudflare --help` runs. **A real Workers build was not run** (the CRM is deployed with Docker; that path remains unverified) |

The Prisma update is the one change that touches runtime code (the generated client and the driver adapter). It is in range (`^7.9.1`), `prisma validate` and `prisma generate` pass, and the whole non-database suite and the build pass; **its behaviour against PostgreSQL is part of the database gate (section 5) and was not run here.**

## 3. What remains (9: 0 critical, 3 high, 6 moderate), advisory by advisory

Reachability, checked rather than assumed: the production image runs `next start` from the Next.js standalone output, which contains only what the server imports; `npm ls` shows every package below is reached only through the Prisma CLI (run by the `tools` container, which has no internet access), the Cloudflare Workers build tool, or the `shadcn` component generator. None is imported by a request handler, a server action, a worker or a script that handles user input (`grep` over `src/` finds only `src/__tests__/cloudflare-config.test.ts`, which mentions the Cloudflare tooling by name as configuration text; nothing imports any of them). "Exposure" below says what an attacker would need.

| # | Package (severity, direct/transitive) | Installed -> fixed | Advisory | Dependency path | Reachable here? | Runtime or build | Fix inside the declared range? | Breaking? | Action |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `effect` (high, transitive) | 3.20.0 -> a release above 3.22.0 | GHSA-7589-6fvf-x4pw: ReDoS while compiling the regex of `Schema.TemplateLiteral` | `prisma` -> `@prisma/config` -> `effect` (exact `3.20.0`) | Only while the Prisma CLI loads the operator's own `prisma.config.ts`; no request, upload or user value reaches it. The application does not import `effect` | Build / operations CLI | **No.** `@prisma/config` 7.10.1 (the newest 7.x) pins 3.20.0; the registry's `latest` tag of `prisma` is `8.0.0-rc.34`, a major release candidate | The offered "fix" is a downgrade to prisma 6.12.0 (a different major with a different config system) | Left open. Re-check on every Prisma 7.x release. An npm `overrides` entry forcing a newer `effect` into the CLI was considered and **not** applied: it would run an untested combination inside the migration tool |
| 2 | `@prisma/config` (high, transitive) | as above | via #1 | as above | as above | as above | No | as above | as #1 |
| 3 | `prisma` (high, **direct**, `^7.9.1`, installed 7.10.1) | as above | via #1 | the CLI itself | as above | as above | No | as above | as #1 |
| 4 | `glob` (moderate, transitive) | 9.0.0-14.0.1 -> newer | GHSA-3g3m-2fjr-6pw4: `AbortSignal` cancellation does not stop a filesystem walk that is already running | `@opennextjs/cloudflare` 1.20.18 -> `glob` | Needs a caller that passes an `AbortSignal` and then relies on it to bound filesystem access on attacker-chosen input; the build tool globs its own project folder | Build only (Workers bundle) | No: pinned inside `@opennextjs/cloudflare` | The offered "fix" is `@opennextjs/cloudflare@0.3.0` (a downgrade to a different major) | Left open; belongs to a Workers build change. (The other advisory against `glob`, the CLI `-c/--cmd` command injection, is **gone** after the 1.20.18 update) |
| 5 | `@opennextjs/cloudflare` (moderate, **direct**, exact pin, listed under `dependencies`) | 1.20.18 | via #4 | the tool itself | as #4 | Build only | No | as #4 | Left open. Optional hygiene: move it to `devDependencies` |
| 6 | `minimatch` (moderate, transitive; two nested copies) | 7.0.0-11.0.0 -> 11.0.1+ | GHSA-g3hv-75wg-m249: DoS through `globparts` amplification with a crafted pattern | `glob` and `@ts-morph/common` | The patterns come from the developer's own tool configuration; no network-supplied pattern ever reaches them | Build / developer CLI | No: nested copies pinned by their parents | Offered fixes are downgrades | Left open |
| 7 | `@ts-morph/common` (moderate, transitive) | 0.19.0-0.29.0 | via #6 | `shadcn` -> `ts-morph` -> `@ts-morph/common` | as #6 | Developer CLI | No | Offered "fix" is `shadcn@1.0.0` (a downgrade) | Left open |
| 8 | `ts-morph` (moderate, transitive) | 18.0.0-27.0.2 | via #6 | `shadcn` -> `ts-morph` | as #6 | Developer CLI | No | as #7 | Left open |
| 9 | `shadcn` (moderate, **direct**, `^4.18.0`, installed 4.23.0) | 4.23.0 | via #6 | the component generator | Run by a developer to add UI components; never imported at runtime | Developer CLI | No (4.23.0 is the newest and still depends on `ts-morph` ^26) | as #7 | Left open. Optional hygiene: move it to `devDependencies` |

What changed in this consolidation (5 advisories closed): `undici` (high, eight GHSAs), `miniflare` (moderate) and `wrangler` (moderate) by the `wrangler` 4.166.0 pin; `@opennextjs/aws` (high), `@node-minify/core` (high) and the glob command-injection advisory by the `@opennextjs/cloudflare` 1.20.18 pin.

Blocks redeployment of the CRM on the VPS? **No.** Items 1-3 are the Prisma CLI's internals and need a Prisma release; items 4-9 are not in the production image. Items 4-9 would matter for a Cloudflare Workers build or a developer's machine. A strict reading of "zero advisories" cannot be met until Prisma ships a fixed `effect`, `@opennextjs/cloudflare` a fixed `glob` and `shadcn` a newer `ts-morph`; this is stated rather than hidden.

Optional hygiene (not a vulnerability fix, not done): `shadcn` and `@opennextjs/cloudflare` sit in `dependencies` although they are build-time tools; moving them to `devDependencies` would make `npm audit --omit=dev` shorter. Left alone to avoid an unrelated change to the Docker build.

## 4. Verification after the updates

`npx tsc --noEmit`, `npx eslint src scripts`, `npx prisma validate` and `npm run build` pass; the full `npx vitest run` result is in `COMPASS_SEQUENCE_WORKFLOW_RELEASE_READINESS.md`. A fresh `npm audit` after the last update reports the 9 above (3 high, 6 moderate, 0 critical). The build no longer prints the three Turbopack tracing warnings (see `COMPASS_SECURITY_PRIVACY_MARKETING_IMPLEMENTATION_REPORT.md`).

## 5. Gate that still applies

Because the Prisma client and PostgreSQL driver adapter changed version, **run the database-gated suite (CI, or a disposable PostgreSQL) before merging**: the claim, reveal-counter and migration tests are the ones that exercise the new client against a real server. If it fails, revert `package-lock.json` and `package.json` to `2849a58` (the Prisma part is independent of the others) and keep the other updates.
