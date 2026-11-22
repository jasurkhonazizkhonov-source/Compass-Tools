# Dependency advisory audit and remediation - 2026-11-22

Scope: `compass-tools-updated`, the actual `package-lock.json`. Tool: `npm audit` (read-only; the registry advisory database), `npm ls` for dependency paths. **No `npm audit fix --force`, no major framework upgrade, no `package.json` range change.** The raw audit JSON files are kept outside the repository next to the audit notes (`F:\Claude Workspace\audit-2026-11-22\npm-audit-*.json`); this document is the human-readable record. Nothing here is a claim that the project is "security-clean": it is the list of what the registry reports, what was changed, and what was left and why.

## 1. Result

| | Critical | High | Moderate | Total |
|---|---|---|---|---|
| Before (lockfile at commit `2849a58`) | 1 | 19 | 18 | **38** |
| After the targeted in-range updates below | **0** | **8** | **6** | **14** |

Method: the packages named in each advisory were updated **within the version ranges their dependents already allow** (`npm update <names>`), in two steps, with the full test suite, type-check, lint, `prisma validate` and the production build repeated after the last step. `package.json` ranges are unchanged; its only change is the install-script allow-list (`allowScripts`), whose keys name exact Prisma versions (`@prisma/engines@7.10.1`, `prisma@7.10.1`) - without that change a clean `npm ci` would silently skip Prisma's install scripts.

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

The Prisma update is the one change that touches runtime code (the generated client and the driver adapter). It is in range (`^7.9.1`), `prisma validate` and `prisma generate` pass, and the whole non-database suite and the build pass; **its behaviour against PostgreSQL is part of the database gate (section 5) and was not run here.**

## 3. What remains (14: 0 critical, 8 high, 6 moderate) and why it is not exploitable in the deployed application

Reachability: the production image runs `next start` from the Next.js standalone output, which contains only what the server imports. None of the packages below is imported by application request handling. They are (a) the Cloudflare Workers build toolchain, which the VPS/Docker deployment does not use, (b) the `shadcn` component generator, (c) the Prisma CLI that the `tools` container runs against PostgreSQL (the container has no internet access), and (d) test/lint tooling.

| Package (severity) | Dependency path | Why it remains | Exposure in this deployment | Blocks redeployment? |
|---|---|---|---|---|
| `prisma` (high), `@prisma/config` (high), `effect` (high) | Prisma CLI -> config loader -> `effect` 3.20.0 (ReDoS in `Schema.TemplateLiteral` regex) | Prisma 7.10.1 still depends on `effect` <= 3.22.0; npm's only offered "fix" is a downgrade to prisma 6.12.0 (a different major with a different config system) - rejected | The regex runs in the CLI while it loads the operator's own `prisma.config.ts`; no request, upload or user value reaches it | No. Re-check when Prisma ships an `effect` >= 3.23 |
| `@opennextjs/cloudflare` (high), `@opennextjs/aws` (high), `@node-minify/core` (high), `glob` (high), `minimatch` (moderate) | Cloudflare Workers build tooling | The only offered "fix" is `@opennextjs/cloudflare@0.3.0` (a semver-major downgrade) | Build time only, on the machine that builds a Workers bundle; not in the Docker image | No for the VPS path. **Blocks any Cloudflare Workers build** until upgraded in its own change |
| `wrangler` (moderate), `miniflare` (moderate), `undici` 7.0-7.30.0 (high) | Cloudflare tooling | `wrangler` is pinned exactly to `4.149.0` (`devDependencies`); the registry's fix is `wrangler@4.166.0` (not a major). Not applied: it is a deliberate exact pin for the Workers build, and moving it needs a Workers build check that cannot be done here | Local dev emulator / build only | No for the VPS path. Candidate for the Workers change |
| `shadcn` (moderate), `ts-morph`, `@ts-morph/common` (moderate) | shadcn CLI | offered "fix" is `shadcn@1.0.0` (a downgrade) | CLI used by a developer to add UI components; never imported at runtime | No. Optional: move `shadcn` to `devDependencies` |

Optional hygiene (not a vulnerability fix, not done): `shadcn`, `prisma`, `@opennextjs/cloudflare` and `wrangler` sit in `dependencies`/`devDependencies` in ways that make `npm ls --omit=dev` over-report; moving build-only tools to `devDependencies` would make future audits easier to read. Left alone to avoid an unrelated change to the Docker build.

## 4. Verification after the updates

`npx tsc --noEmit`, `npx eslint src scripts`, `npx prisma validate` and `npm run build` pass; the full `npx vitest run` result is in `COMPASS_SEQUENCE_WORKFLOW_RELEASE_READINESS.md`. A fresh `npm audit` after the last update reports the 14 above. The build no longer prints the three Turbopack tracing warnings (see `COMPASS_SECURITY_PRIVACY_MARKETING_IMPLEMENTATION_REPORT.md`).

## 5. Gate that still applies

Because the Prisma client and PostgreSQL driver adapter changed version, **run the database-gated suite (CI, or a disposable PostgreSQL) before merging**: the claim, reveal-counter and migration tests are the ones that exercise the new client against a real server. If it fails, revert `package-lock.json` and `package.json` to `2849a58` (the Prisma part is independent of the others) and keep the other updates.
