# CRM release-blocker investigation and safe remediation - 2026-11-13

Scope: `F:\Claude Workspace\compass-tools-updated` only. The original CRM was not modified (inventory: 951 files, 0 differences against its baseline). Nothing was committed, staged,
unstaged, stashed, reset, merged or deployed; no database was created or contacted; no migration was run; no server was stopped or restarted. This report follows the brief's
12 numbered items; it supersedes nothing in `FINAL_PRODUCTION_READINESS_AUDIT_2026-11-13.md` - it verifies it.

## 1. Initial Git and merge-state inventory (re-checked, not assumed)

| | At start of this task | At end |
|---|---|---|
| Branch / HEAD | `work/commission-salesboard-notes-ui` / `5a77976` | same |
| `MERGE_HEAD` | `c6b8d8e` ("Fix Cloudflare token variable in CI smoke test"), merge base `2daf3f6` | same |
| Staged | 79 (34 A, 41 M, 4 D) | 79 (identical list) |
| Index file SHA-256 (prefix) | `3422053116ff4701` | `3422053116ff4701` |
| Stash | 1 (`pre-merge: UI dev-CSP change (src/lib/csp.ts)`) | 1 |
| Unmerged entries / conflict markers | 0 / none | 0 / none |
| Unstaged / untracked | 74 / 101 (collapsed to 196 porcelain lines) | + the files listed in section 4 |

**Ownership of the uncommitted work** (by comparing with the inventory taken before the 2026-11-13 implementation work): of 74 unstaged files, 49 are pre-existing user work
(commissions/salesboard/reports UI, sign-in and inquiry geolocation, bulk selection, session/auth, CSP, permissions, prisma schema/seed, `vitest.config.ts`, README/.gitignore)
and 25 are this release's hardening (the nine phases of the earlier task). Of 101 untracked files, 89 are pre-existing (36 docs, geolocation `src/server/geo/*`, bulk-selection and commission
components, the disposable-database guard, two migrations) and 12 are the earlier hardening.

## 2. Unfinished merge and release structure

**What the staged merge is.** `MERGE_HEAD` is the self-hosting branch (Docker, Compose, deploy scripts, systemd timers, local-disk uploads, CI). Classifying every staged path against both parents:
73 files are byte-identical to `MERGE_HEAD` (taken whole), 2 were hand-merged (`.env.example`, `prisma/schema.prisma`), 4 are deletions (`src/server/storage/r2.ts` and its three tests: R2 storage is replaced by
local disk). 11 further files changed by `MERGE_HEAD` are not staged only because `HEAD` already contains them (the website API). There are no unmerged paths and no conflict markers.

**Are staged additions and the working tree compatible?** Yes, demonstrably: the full suite (318 files, 4,565 tests) passes against exactly this combined state (section 5), `tsc` and ESLint are clean, and `npm run build` succeeds.
Fifteen files are staged *and* edited afterwards (`MM`/`AM`): `.env.example`, `.gitignore`, `README.md`, `deploy/ci-smoke.sh`, `deploy/verify.sh`, `docs/DEPLOYMENT.md`, `next.config.ts`, `package.json`, `package-lock.json`,
`prisma/schema.prisma`, `src/__tests__/session-enforcement-coverage.test.ts`, `src/app/(crm)/leads/[id]/page.tsx`, `src/app/api/cron/__tests__/cvv-cleanup.test.ts`, `src/app/api/health/__tests__/route.test.ts`, `src/lib/csp.ts`.
For these, the working-tree version is the tested one.

**Where the deployment files are.** `HEAD` contains no `Dockerfile`, `compose.yaml`, `.dockerignore`, `deploy/`, `scripts/healthcheck.mjs` or `.github/workflows/ci.yml`: they exist only as staged additions of this merge.

**Why the deploy script rejects the checkout.** `deploy/deploy.sh` (a) stops when `git status --porcelain --untracked-files=no` is not empty (staged and modified tracked files make it non-empty), (b) requires the target commit to be an ancestor of
`origin/main`, and (c) fast-forwards only. The current tree satisfies none of these.

**Safe remediation plan (not performed; needs your approval; preserves every change).**
1. Take a safety copy of the whole directory (outside the repo) and note `git stash list`, the index SHA above and `git diff --cached > staged.patch`.
2. Review the staged merge result as is (73 theirs, 2 hand-merged, 4 deletions) and decide whether R2 -> local-disk storage is the intended release behaviour (it is a functional change; see section 8).
3. `git commit` to conclude the merge exactly as staged (no `-a`): this records the self-hosting branch.
4. Stage the working-tree work in coherent groups, each its own reviewed commit: (a) pre-existing user work (geolocation, bulk selection, commissions/salesboard), (b) the 2026-11-13 hardening (sanitizer, health, process-due split, idempotency, poller switch, dependency updates with `package.json` + lockfile together), (c) the two migrations (BOM-free, section 3), (d) tests/docs. Never `git add -A`: untracked `docs/recovery-archive`, `data/`, local tooling must be excluded (they are git-ignored or must be reviewed).
5. The one stash (`src/lib/csp.ts`, a dev-only CSP change) is already reflected in the working tree (`csp.ts` is `MM`); leave it until the owner confirms it is redundant.
6. Push the branch, open the pull request, merge to `origin/main`, then deploy that commit with `deploy.sh --ref <sha>`.

## 3. Inquiry-submission migration and the UTF-8 BOM

* **Structure:** `20261113000100_inquiry_submission_info/migration.sql` creates `InquirySubmissionInfo` (11 columns, primary key), a unique index on `inquiryId` and a foreign key to `"ContactInquiry"` with `ON DELETE CASCADE`. It matches the Prisma model added in `schema.prisma`, sorts last (after `20261108000100`), and is additive.
* **The BOM:** the file began with `EF BB BF`; it was the only one of 75 migration files that did. PostgreSQL's scanner accepts bytes >= 0x80 as identifier characters, so the mark becomes a stray identifier in front of the first statement and the file cannot parse (`syntax error at or near`). I could not *execute* this (no database is permitted), so the conclusion is from the documented lexer rule, not from a run. A BOM-free file is valid in every case, so correcting it has no downside.
* **Safe to change?** Yes: the file is untracked (not in the index, not in the merge); `src/lib/migration-manifest.json` records migration *names* only (no checksum), so it is unaffected; no database is known to have applied it (nothing was ever migrated; the project has no `.env`).
* **Change made:** the three BOM bytes were removed (1,332 -> 1,329 bytes; every other byte identical, checked with `cmp`; backup kept outside the repo). 0 of 76 migrations now start with a BOM.
* **Guard added:** `src/lib/__tests__/migration-files.test.ts` (3 tests, pass) fails if any migration has a UTF-8 BOM, a UTF-16 mark, a NUL byte, is not valid UTF-8, or is empty.
* **Verification still required:** apply both new migrations to a disposable database that mirrors production's migration state (`prisma migrate deploy`), then `prisma migrate status` and the idempotency integration test (section 6).

## 4. Test reliability

| Observation | Evidence |
|---|---|
| Failing tests across runs | run A (alone): `quote-builder-gds-tabs` "never mixes a previous Sabre parse into a fresh Apollo parse after switching tabs" failed (duration 16.5 s); run B (with other commands running): `deploy-image-version` (real shell code with a stub docker, expected output `''`), `leads` and `reassignment` (45.8 s and 49.0 s), plus four files that crashed ("child process was torn down", a transient `@radix-ui/react-context` resolution error) |
| Alone, repeatedly | the seven affected files: 129/129 pass; `quote-builder-gds-tabs` 8/8 three times in a row |
| Cause | resource contention, not an implementation defect: this machine has 7.7 GB RAM (about 0.7 GB free) and 12 logical CPUs; Vitest started 12 workers, each loading jsdom, React and the generated Prisma client, so tests that take under a second alone took 16-49 s. A jsdom test then misses the Testing Library `asyncUtilTimeout`, or a worker is killed. A different file failed each time, which is the signature of load, not of a bug |
| Fix | `vitest.config.ts`: `maxWorkers` capped at 4 (`VITEST_MAX_WORKERS` overrides), with the measured reasoning in a comment. **No test, assertion, timeout or coverage changed** |
| Result | with the cap: two full runs at `--maxWorkers=4` (3,990 / 0 failed; second run 4,001 with only my own new test failing, see below) and two full runs by plain `npx vitest run` after the change: **318 files, 4,565 tests, 4,003 passed, 0 failed, 562 skipped, both runs** (275 s and 341 s) |
| Own mistake found and fixed | the first draft of my new unsubscribe test expected "not 500" but the page helper's `error` kind returns 500; the route now returns the `missing` page (HTTP 400) for a refused or unreadable body, and the test asserts 400 |

## 5. Database-dependent verification - what is skipped and what it proves

562 skipped = **559 PostgreSQL-dependent** (27 `__integration__` files: 537 tests, including the new idempotency suite which has not been run; plus `reference-data.test.ts`: 22) + 3 OS-conditional file-permission tests (`storage/local.test.ts`).
They are gated by `INTEGRATION_DATABASE_URL` and the fail-closed guard (`src/test/integration-database-guard.ts`: loopback literal, database named exactly `compass_test`, confirmed by the live server). The guard was not touched and no database was created.

| Feature | Skipped tests | What only real PostgreSQL proves |
|---|---|---|
| Lead attachments (upload, download, authorization, quotas, cleanup) | 78 | transactional status flow `PENDING`->`READY`, unique `storageKey`, cleanup under concurrency |
| Sessions / privilege step-up / audit log / manager teams | 37 + 9 + 7 + 21 + 15 | single-active-session revocation, atomic `updateMany` claims, audit append-only behaviour, team scoping queries |
| Website API, lead capture, lead queue, lead IP authorization, inquiry separation, duplicate guards, reassignment, lead updates | 35 + 26 + 10 + 22 + 11 + 3 + 6 + 27 + (8 new) | **idempotency by derived primary key and fingerprint**, concurrent duplicates, advisory locks, nested creates (`activities`, `submissionInfo`), queue claim, inbox separation, IP reveal rules |
| Bookings and payments (submit, CVV retention, card vault, airline confirmation, quote pricing, airline history) | 26 + 21 + 10 + 12 + 21 + 8 | encrypted-field round trips, CVV purge, unique constraints, pricing calculations on stored data |
| Reporting and bulk actions | 19 + 28 | pay-period aggregation SQL, bulk selection over real row sets |
| System health / readiness | 28 | real `_prisma_migrations` comparison, pool statistics |
| Reference data / airline reference | 22 + 29 | seeded airport/airline lookups, partial unique indexes |
| Vercel-build migration script | 5 | obsolete for the VPS release path |

Everything outside this table is verified by mocks or static tests, which prove **logic**, not **database behaviour**. The previous "3,990 passed" therefore says nothing about the items in this table.

## 6. Website-to-CRM API integration - what was verified

Verified by reading both sides (website builders and the CRM's real schemas and routes) and by the mocked suites; **not** against a live CRM.

| Topic | Finding |
|---|---|
| Authentication / company scoping | Flight API: Bearer key (>= 32 chars, constant-time compare, optional second key for rotation), company fixed by `WEBSITE_API_COMPANY_ID`, failed-auth counter then 429, public-hostname requests get 404. Contact/subscribe: unauthenticated, `companyId` in the body must exist |
| Flight request | strict schema (unknown field or `submissionId`/`companyId` in the body = 400), 32 KB bounded read, E.164 possible-number check; website builder emits exactly the allowed fields; enums and limits match (website is stricter) |
| Contact | schema fields and the 5-value `subject` enum match; `submissionId` (8-200 chars of `A-Za-z0-9._-`) accepted only on the route that opts in; unkeyed requests are stored exactly as before (the existing integration test that asserts "no duplicate collapsing" stays true) |
| Newsletter | `companyId`, `email`, `source` match |
| Validation / errors | JSON error contract with field paths only; no echo of values, keys or stack traces |
| Duplicates / idempotency | flight: key -> derived lead id, fingerprint of the canonical request, repeat = 200 `duplicate:true`, same key with a different request = 409; contact: derived inquiry id, content lock + key lock, repeat = 200 `duplicate:true`, key reuse for different content = 409 |
| Retry / timeout | website: flight retries (same key, same bytes) on 429/5xx/timeout; contact and newsletter one attempt per press; the visitor's resend is safe |
| Persistence / activity | lead + contact + status history + `LEAD_CREATED` activity + submission info + fingerprint in ONE insert; contact inquiry + submission info in one insert; staff notification best-effort |
| Race observed in review (not fixed) | `createWebsiteFlightLead` resolves/creates the Contact *before* the lead insert, so two simultaneous requests with different keys but the same new phone/email can each create a Contact (the lead itself is protected by its key). This is existing behaviour shared with agent-entered leads; it needs the PostgreSQL integration suite to quantify and, if wanted, a unique-constraint or lock - out of scope here |
| New: integration test | `src/server/actions/__integration__/public-inquiry-idempotency.integration.test.ts` - 8 tests for the contact path (single keyed insert, resend, 8 simultaneous identical, simultaneous same-key/different-content, 409 without overwrite, separate keys, cuid coexistence, other company). **Written, not run** (skipped without a disposable database) |

## 7. Security and dependencies (38 findings, `npm audit`, read-only)

`npm audit` totals: 1 critical, 18 high, 18 moderate, 1 low. `npm ls --all` consistent. Installed: next 16.4.6, nodemailer 10.1.4, zod 4.6.6 (root), sanitize-html 2.18.1, Tiptap 3.34.0, ProseMirror view 1.42.9, Prisma 7.9.1.
**Reachability:** none of the packages below is imported by `src/` or `scripts/`; the Docker runner stage is a Next standalone bundle (traced imports only) started with `node server.js`; the Prisma CLI chain lives in the `tools` (migration) image. The standalone trace was **not observed** (no Docker, no CRM standalone build), so "not in the runtime image" is inferred.

Package families and findings:

* **`shadcn` CLI** (declared under `dependencies`): its MCP SDK / `express` / `body-parser` / `proxy-addr` (the one critical) / `hono` / nested `zod@3.25.76` / `js-yaml` / `ts-morph` chain. CLI-only; fix = move `shadcn` to `devDependencies` (no runtime effect either way).
* **`@opennextjs/cloudflare` + `wrangler`** (Cloudflare Workers build only; the VPS uses Docker): `@opennextjs/aws`, `@node-minify/core`, `glob`, `minimatch`, `brace-expansion`, `undici`, `miniflare`. Fix needs a major (`@opennextjs/cloudflare@0.3.0` is *lower* than the installed 1.20.10, i.e. npm's suggestion is a downgrade, not a fix) - do not apply.
* **Prisma CLI**: `prisma` / `@prisma/config` / `deepmerge-ts` / `mysql2` (MySQL-only advisory, irrelevant to PostgreSQL) - compatible fix exists but means a Prisma upgrade; not recommended in this release.
* **`fast-uri`** via `@hookform/resolvers` -> `ajv`: the app imports only `@hookform/resolvers/zod`, so `ajv` is never loaded.
* **Dev tooling:** `vite`, `vitest`, `typescript-eslint` family.

Full table (installed version, severity, who pulls it in, fix availability):

| Package | Installed | Severity | Pulled in by (declared dependency) | Fix available | Advisory (first) |
|---|---|---|---|---|---|
| `proxy-addr` | 2.0.7 | critical | @opennextjs/cloudflare | yes (compatible) | proxy-addr vulnerable to IP spoofing via IPv4-mapped IPv6 trust subnet |
| `@modelcontextprotocol/sdk` | 1.30.0 | high | shadcn | yes (compatible) | MCP TypeScript SDK: OAuth client could send credentials to an authorization server chosen by th |
| `@node-minify/core` | 9.0.2 | high | @opennextjs/cloudflare | @opennextjs/cloudflare@0.3.0 (major) | via glob |
| `@opennextjs/aws` | 4.1.9 | high | @opennextjs/cloudflare | @opennextjs/cloudflare@0.3.0 (major) | via @node-minify/core |
| `@opennextjs/cloudflare` | 1.20.10 | high | @opennextjs/cloudflare | @opennextjs/cloudflare@0.3.0 (major) | via @opennextjs/aws, glob |
| `@prisma/config` | 7.9.1 | high | prisma | yes (compatible) | via deepmerge-ts |
| `body-parser` | 2.3.0 | high | @opennextjs/cloudflare | yes (compatible) | body-parser vulnerable to Denial of Service via trailing bytes after a compressed request body |
| `brace-expansion` | 1.1.18 | high | @opennextjs/cloudflare, shadcn | yes (compatible) | brace-expansion: Quadratic-time expansion of the `{a},b}` rewrite causes CPU denial of service |
| `deepmerge-ts` | 7.1.5 | high | prisma | yes (compatible) | DeepmergeTS has stack exhaustion when merging recursive object graphs |
| `fast-uri` | 3.1.5 | high | @hookform/resolvers | yes (compatible) | fast-uri vulnerable to host confusion via skipped IDN canonicalization on scheme-relative refer |
| `glob` | 13.0.6 | high | @opennextjs/cloudflare | @opennextjs/cloudflare@0.3.0 (major) | glob CLI: Command injection via -c/--cmd executes matches with shell:true |
| `js-yaml` | 4.3.1 | high | shadcn | yes (compatible) | js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources |
| `mysql2` | 3.15.3 | high | prisma | yes (compatible) | MySQL2: Auth Plugin Downgrade to mysql_clear_password Leaks Plaintext Credentials |
| `prisma` | 7.9.1 | high | @prisma/client, prisma | yes (compatible) | via @prisma/config, mysql2 |
| `shadcn` | 4.18.0 | high | shadcn | shadcn@1.0.0 (major) | via deepmerge, ts-morph, zod |
| `systeminformation` | 5.33.1 | high | shadcn | yes (compatible) | systeminformation has path traversal in Linux networkStats() that allows symlink-based file dis |
| `undici` | 7.29.0 | high | @opennextjs/cloudflare, shadcn | wrangler@4.162.0 | undici vulnerable to Denial of Service via unhandled error in WebSocket permessage-deflate deco |
| `vite` | 8.2.1 | high | (dev only) | yes (compatible) | launch-editor: escapeCmdArgs() omits % escaping on Windows |
| `zod` | 4.6.6 | high | @hookform/resolvers, shadcn, zod | shadcn@1.0.0 (major) | Zod can exhaust memory while validating oversized constrained collections |
| `@hono/node-server` | 2.1.1 | moderate | shadcn | yes (compatible) | @hono/node-server: `serveStatic` decodes the request path a second time, leading to bypass of m |
| `@ts-morph/common` | 0.27.0 | moderate | shadcn | yes (compatible) | via minimatch |
| `@typescript-eslint/eslint-plugin` | 8.67.0 | moderate | (dev only) | yes (compatible) | via @typescript-eslint/type-utils, @typescript-eslint/utils |
| `@typescript-eslint/parser` | 8.67.0 | moderate | (dev only) | yes (compatible) | via @typescript-eslint/typescript-estree |
| `@typescript-eslint/type-utils` | 8.67.0 | moderate | (dev only) | yes (compatible) | via @typescript-eslint/typescript-estree, @typescript-eslint/utils |
| `@typescript-eslint/typescript-estree` | 8.67.0 | moderate | (dev only) | yes (compatible) | via minimatch |
| `@typescript-eslint/utils` | 8.67.0 | moderate | (dev only) | yes (compatible) | via @typescript-eslint/typescript-estree |
| `@vitest/mocker` | 4.1.10 | moderate | (dev only) | yes (compatible) | Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock |
| `hono` | 4.13.2 | moderate | shadcn | yes (compatible) | Hono: Incomplete fix for CVE-2026-39408: `toSSG()` still writes files outside the output direct |
| `ip-address` | 10.5.0 | moderate | shadcn | yes (compatible) | ip-address: Address6.isLinkLocal() recognizes fe80::/64 rather than fe80::/10, allowing SSRF an |
| `miniflare` | 5.20261006.1-alpha | moderate | @opennextjs/cloudflare | wrangler@4.162.0 | via undici |
| `minimatch` | 3.1.5 | moderate | @opennextjs/cloudflare, shadcn | @opennextjs/cloudflare@0.3.0 (major) | minimatch has potential denial of service via globparts amplification |
| `postcss-selector-parser` | 7.1.5 | moderate | shadcn | yes (compatible) | PostCSS: Quadratic complexity in flat selector parsing allows CPU exhaustion |
| `qs` | 6.15.3 | moderate | @opennextjs/cloudflare | yes (compatible) | qs array-limit bypass via bracket-key comma parsing |
| `ts-morph` | 26.0.0 | moderate | shadcn | yes (compatible) | via @ts-morph/common |
| `typescript-eslint` | 8.67.0 | moderate | (dev only) | yes (compatible) | via @typescript-eslint/eslint-plugin, @typescript-eslint/parser, @typescript-eslint/typescript- |
| `vitest` | 4.1.10 | moderate | (dev only) | yes (compatible) | Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock |
| `wrangler` | 4.149.0 | moderate | @opennextjs/cloudflare | wrangler@4.162.0 | via miniflare |
| `deepmerge` | 4.3.1 | low | shadcn | shadcn@1.0.0 (major) | deepmerge mergeObject() allows prototype poisoning of returned objects |

Recommendation: no dependency change in this release. Follow-up: move `shadcn`, `@opennextjs/cloudflare`, `wrangler` to `devDependencies`; update `vitest`/`vite` within their ranges; re-audit.

## 8. Runtime, Docker and the HTTP 500 on port 3001

* **Cause of the 500:** the dev server (PID 9836) was started at 06:54 with Next.js 16.3.8 (its own log header says so); `node_modules/next` was replaced by 16.4.6 at 07:11. The running process loads new files lazily against old, already-loaded modules, which produces `ensureInstrumentationRegisteredWithDeferredSpans is not a function`. It is a version-mixed process, not a source defect: the current source type-checks, lints, and builds.
* **Second, independent reason it would still 500 after a restart:** the project has no `.env` (production values were deliberately never copied), so `GOOGLE_CLIENT_ID` and `DATABASE_URL` are unset and every sign-in/DB-backed page fails (`/login` throws "GOOGLE_CLIENT_ID is not configured"; `/api/health` reports the database as down). This is the audit's C10 and is expected in this environment.
* **Checked safely:** `bash -n` on all 13 `deploy/*.sh`; `node --check` on `healthcheck.mjs` and `cvv-cleanup-scheduler.mjs`; `compose.yaml` parses (services `db`, `app`, `cloudflared`, `cvv-cleanup`, `tools`; networks `data`, `web`, `website_api`); `selfhost-deployment-config.test.ts`, `deploy-image-version.test.ts` (real shell code against a stub docker) pass; `npm run build` (plain Next build) succeeds; the Docker healthcheck still accepts the minimal `/api/health`.
* **Needs an authorized Docker environment:** `docker compose build` of `app`/`tools` (the `NEXT_OUTPUT=standalone` + `prisma generate` path), `docker compose config` against a real `.env`, `deploy/preflight`/`verify.sh` runs, image size and `tools` migration job.
* **Data-compatibility fact to confirm before release:** the merge deletes the R2 storage code and serves attachments from local disk. If any production `Attachment` row was written by the R2 implementation (non-null `storageKey`), local storage cannot serve it. Verify (read-only count) in production before deploying.

## 9. Existing feature review

Reviewed by code reading and by the full suite; confirmed working = passes mocked/static tests on this source; "not yet verified" = needs the database suite or a live environment.

| Area | Status |
|---|---|
| Authentication, session handling, role/permission enforcement | logic confirmed (permission changes are additions only; `session-enforcement-coverage` passes); real session revocation is DB-dependent -> not yet verified |
| Lead intake, flight requests, inquiries, duplicate protection | logic confirmed; idempotency and races DB-dependent -> not yet verified (section 6) |
| Campaign creation, sanitization, preview, email build | confirmed (57 + 5 tests); preview iframe not observed in a browser |
| Background jobs, in-process poller, process-due actions | confirmed (guard tests, concurrency tests with mocks); claims need PostgreSQL |
| Notifications, activity records | confirmed via mocks; persistence DB-dependent |
| File/logo uploads | local-disk storage tests pass (3 OS-conditional skipped); upload route authorisation DB-dependent; R2 data question above |
| Health / readiness endpoints | confirmed in code and tests; not observed live |
| Validation and error handling | confirmed (public endpoints use bounded readers; **new:** the unsubscribe POST now has one) |

## 10. Modified and added files in this task (all inside `compass-tools-updated`, working tree only)

| File | Change | Why / verification |
|---|---|---|
| `prisma/migrations/20261113000100_inquiry_submission_info/migration.sql` (untracked) | removed 3 BOM bytes | section 3; `migration-files.test.ts` |
| `src/lib/__tests__/migration-files.test.ts` (new) | static migration-file guard | prevents recurrence |
| `vitest.config.ts` (unstaged, user-modified) | + `maxWorkers` cap block | section 4; two full runs 0 failures |
| `src/server/security/read-limited-form.ts` (new) | bounded form reader | audit finding C7 |
| `src/app/api/public/unsubscribe/route.ts` (tracked, previously unmodified) | `req.formData()` -> `readLimitedForm(req)`; refused/unreadable body -> HTTP 400 page | 5 + 5 new tests, existing 34 unsubscribe tests unchanged |
| `src/server/security/__tests__/read-limited-form.test.ts`, `src/app/api/public/unsubscribe/__tests__/route-body-limit.test.ts` (new) | tests for the above | |
| `src/server/actions/__integration__/public-inquiry-idempotency.integration.test.ts` (new) | DB test for contact idempotency | written, **not run** |
| `docs/CRM_RELEASE_BLOCKER_INVESTIGATION_2026-11-13.md` (new) | this report | |

No file in the staged set was modified in this task beyond what the previous task had already edited (`index` identical). The unfinished merge was not touched.

## 11. Tests run and their results

| Check | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| ESLint (`src`, `vitest.config.ts`) | 0 problems |
| Full suite, default invocation, run 1 and run 2 | 318 files / 4,565 tests: **4,003 passed, 0 failed, 562 skipped**, both |
| Full suite at `--maxWorkers=4` before the config change | 3,990 / 0 failed / 554 skipped (before new tests); second run 4,001 passed, 2 failed = my own new test's wrong expectation (fixed) |
| New and related unit tests | `migration-files` 3, `read-limited-form` 5, `route-body-limit` 5, existing unsubscribe route tests: all pass |
| Previously flaky files in isolation | 129/129 (seven files); `quote-builder-gds-tabs` 8/8 x3 |
| Skipped / blocked | 559 database-dependent (blocked: no authorised disposable database), 3 OS-conditional |
| Not run | Docker build, live health/headers/preview, any production or live-CRM request |

## 12. Remaining blockers and a safe sequence for completing the CRM release

**Blockers:** (1) the release is not a commit (approval needed for the merge commit and the follow-up commits); (2) PostgreSQL verification of the 559 skipped tests and of both migrations, in particular the contact and flight idempotency paths; (3) no Docker build verified; (4) production migration state, R2 data question and VPS network layout unknown; (5) a local dev server on 3001 that is mismatched and unconfigured (not a release blocker).

**Sequence:** 1) approve and execute the commit plan in section 2; 2) authorise a disposable PostgreSQL (`compass_test`) and run the 28 database-dependent files plus `prisma migrate deploy` of all 76 migrations from a production-like state; 3) build both images in CI; 4) read production state read-only (`migrate status`, attachment `storageKey` count, networks); 5) backup, `deploy.sh --ref <sha>` without then with `--migrate`; 6) verify with `verify.sh` and the data-free checks in the joint release report; 7) keep the previous image and backup for rollback.
