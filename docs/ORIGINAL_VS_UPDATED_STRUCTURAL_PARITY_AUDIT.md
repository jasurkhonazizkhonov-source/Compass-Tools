# Compass-Tools — original vs updated: structural parity audit

Date: 2026-11-13 (the audit ran late in the day, after other sessions had changed the working tree). Read-only comparison: no source file, schema, migration, configuration, Git object or database was modified. The only files written are this report and its two siblings (`CRM_FEATURE_AND_API_COMPATIBILITY_AUDIT.md`, `CRM_DATABASE_AND_DEPLOYMENT_COMPATIBILITY_AUDIT.md`) in `compass-tools-updated/docs/`.

Decision for this report — **Structural parity: READY WITH CONDITIONS** (section 12).

## 1. Methodology

| Method | Detail |
| --- | --- |
| File comparison | SHA-256 of every file after normalising line endings (the Windows working trees are CRLF through `core.autocrlf`), excluding `node_modules`, `.next`, `.git`, `test-results`, `.local-uploads`, `.agents`, `.windsurf`, `.codex`. 975 original files, 1,049 updated files. |
| Source parity | For each of the 435 non-test source files under `src/` of the original, the same path was looked up in the updated tree and the list of exported names (`export function/const/class/type/interface/enum`, `export { … }`) compared. |
| Route inventory | Every `page.tsx`/`route.ts` (and the metadata routes) under `src/app`, route groups removed; for the 16 route handlers the exported HTTP methods were compared and every differing handler was diffed. |
| Schema/migrations | `prisma/schema.prisma` diff; every migration directory compared by name, order and (BOM/line-ending-normalised) content. |
| Infrastructure | `Dockerfile`, `compose.yaml`, `.dockerignore`, `deploy/*`, `.github/workflows/ci.yml`, `wrangler.jsonc`, `open-next.config.ts`, `vercel.json` compared by content; environment-variable names read by the code and listed in `.env.example` compared; `compose.yaml` parsed. |
| Git | `git status`, `git diff --cached`, `git rev-parse`, blob comparison of every staged path with `MERGE_HEAD`. Nothing was staged, unstaged, committed, reset, stashed or checked out. |
| Execution | `tsc`, `eslint`, `prisma validate`, the complete no-database Vitest suite (twice), a production standalone build against a throw-away database URL, `npm audit`. No database, no server of the CRM was started. |
| Limits | The original CRM's `.env` was **not opened** (it points at a remote database). The original's `.git/config` is unreadable, so its Git history was not used. Nothing was sent to any production service. |

## 2. Git state at the start of the audit (verified, not assumed)

| Item | Verified value |
| --- | --- |
| Branch / HEAD | `work/commission-salesboard-notes-ui` / `5a77976` |
| `MERGE_HEAD` | `c6b8d8e` — merge unfinished (merge base `2daf3f6`) |
| Index SHA-256 | `3422053116FF4701…9649BEC` — **identical to the value recorded earlier in the day** (the index was not touched by anything in this audit) |
| Staged | **79** entries: 34 added, 41 modified, 4 deleted. By blob comparison with `MERGE_HEAD`: **73 are byte-identical to `MERGE_HEAD`**; **2 differ (hand-merged): `.env.example` and `prisma/schema.prisma`**; 4 deletions (`src/server/storage/r2.ts` and its three tests), none of which exists in `MERGE_HEAD` either. This confirms the earlier "73 + 2 + 4" report exactly. |
| Staged paths missing on disk | none; no staged deletion still has a file on disk |
| Unstaged changes (tracked files) | 74 files (59 modified only in the working tree, 12 `MM` and 3 `AM` that are also staged) — complete list in Appendix A |
| Untracked | 65 entries at the start of the audit (Appendix B, produced at the end, also lists this report) |
| Stashes | 1: `stash@{0}` "pre-merge: UI dev-CSP change (src/lib/csp.ts)" — pre-existing, not created by this audit |
| Migration under investigation | `prisma/migrations/20261113000100_inquiry_submission_info/migration.sql` — **untracked, not staged** (confirmed) |
| Processes | A `next dev -p 3001` server (started 06:54 local) was already running for this project; see section 10. It was not touched. |

Note: the report you pasted said "seven files were reported as changed"; the actual set of working-tree changes relative to the index is **74 tracked files plus 65 untracked paths** (at the start of the audit) (Appendices A and B). The seven are a subset.

## 3. Root-level structure

Identical in both (after line-ending normalisation): `Dockerfile`, `compose.yaml`, `.dockerignore`, `.gitattributes`, `wrangler.jsonc`, `open-next.config.ts`, `vercel.json`, `.github/workflows/ci.yml`, `components.json`, `eslint.config.mjs`, `postcss.config.mjs`, `tsconfig.json`, `prisma.config.ts`, `AGENTS.md`, `CLAUDE.md`, `deploy/{deploy,common,compose,backup-*,restore-*,rollback,check-migration-drift…}.sh`, `scripts/healthcheck.mjs`, `public/*` (7 of 8; `_headers` differs only in line endings).

Different in the updated project:

| File | Difference | Classification |
| --- | --- | --- |
| `package.json` | `dev`/`start` use port 3001 (workspace port plan); scripts `geoip:*`; dependencies `maxmind`, `sanitize-html` (+ `@types`); upgrades `next` 16.3.8→16.4.6, `eslint-config-next` likewise, `nodemailer` ^9.0.5→^10.1.4, `zod` ^4.4.3→^4.6.6, `@tiptap/*` ^3.30→^3.34 | Intentional improvement (security upgrades; the upgrade approval was given outside this session). The port change is local-only: the Docker image runs `node server.js` with `PORT=3000` and never calls `npm start`. |
| `package-lock.json` | consistent with `package.json`: lock has next 16.4.6, nodemailer 10.1.4, zod 4.6.6, sanitize-html 2.18.1, maxmind 5.0.8; no dependency missing from the lock | Intentional improvement |
| `next.config.ts` | `poweredByHeader: false` (one switch) | Intentional improvement |
| `vitest.config.ts` | `globalSetup` (disposable-database guard) and `maxWorkers` cap | Intentional improvement (section 8) |
| `.env.example` | +`GEOIP_DB_PATH`, +`DISABLE_IN_PROCESS_POLLER`, comment relocations; **no name removed** | Intentional improvement |
| `.gitignore` | ignores `/data/geoip/`, `*.mmdb`, `*.mmdb.gz` | Intentional improvement |
| `deploy/verify.sh`, `deploy/ci-smoke.sh` | send `Authorization: Bearer $CRON_SECRET` to `/api/health` (detail now needs it) | Intentional replacement (compatible; see feature/API report) |
| `README.md`, `docs/DEPLOYMENT.md`, `docs/SECURITY_POSTURE.md` | documentation | Intentional improvement |
| `prisma/schema.prisma` | additive only (section 5 of the database report) | Intentional improvement |

Present only in the original: `.claude/*` (23 tooling files), `.env` (remote-database settings — never read), `skills-lock.json`, and two **zero-byte stray files named `client` and `server`** (shell-redirect artefacts). None is application code. Classification: Intentional removal (tooling/secrets/artefacts) — **not** regressions.

Present only in the updated project (101 files): `data/geoip/city.mmdb` (≈125 MB, git-ignored, local only), 38 documents, 2 migrations, 2 scripts (`geoip-database.ts`, `backfill-sign-in-locations.ts`), 58 files under `src/`. Classification below.

## 4. Directory comparison (non-generated files)

| Directory | Original | Updated | Note |
| --- | --- | --- | --- |
| `src/app` | 89 | 90 | +1 test (`unsubscribe/__tests__/route-body-limit.test.ts`); route set identical |
| `src/components` | 216 | 231 | +15: bulk selection, active-sequences, inquiry-submission, range-date-fields, note-meta (+ tests) |
| `src/lib` | 137 | 143 | +6: `bulk-selection`, `poller-config`, tests |
| `src/server` | 264 | 298 | +34: `geo/*`, `due-sequence-steps`, `due-task-notifications`, `inquiry-id`, `inquiry-submission-info`, `sequence-enrollment-eligibility`, `email/sanitize-campaign-html`, `security/read-limited-{json,form}`, bulk/status-enroll/inquiry actions and queries (+ tests) |
| `src/test` | 3 | 4 | the original's disposable-database guard now exists here too, plus `integration-database-guard.ts` |
| `src/data`, `public`, `deploy`, `.github` | 3 / 8 / 17 / 1 | 3 / 8 / 17 / 1 | unchanged counts |
| `prisma` | 86 | 88 | +2 migrations |
| `scripts` | 17 | 19 | +2 (GeoIP) |
| `docs` | 14 | 53 | reports, recovery archive, GeoIP, requirements |
| `src/hooks`, `src/types`, `src/styles` | — | — | **do not exist in either project**; nothing is missing |

The `src/components` and `src/server` sub-directory sets differ only by the additions above (`commissions`, `geo`, and the new top-level `src/server/*.ts` modules).

## 5. Source-level parity

* **435 of 435** original source files exist at the same path in the updated project.
* **0 exported names were removed** from any of them; 26 were added.
* Seven original files are corrupted in the original working tree (NUL bytes): `src/components/customer/customer-theme-provider.tsx`, `src/components/marketing/reveal.tsx`, `src/lib/sequence-variables.ts`, `src/server/lead-intake.ts`, `src/server/actions/__tests__/account-visibility.test.ts`, `src/server/queries/__tests__/reference-data.test.ts`, `src/test/__tests__/disposable-database.test.ts` (and `docs/WEBSITE_LEAD_API.md`). The updated project holds intact, working versions of all of them (the guard test was re-written). Classification: the original is the defective side; no regression in the update.
* 79 source files differ in content (9 are the regenerated, git-ignored Prisma client). Every one is accounted for in sections 7 and 8.

## 6. Routes

| | Original | Updated |
| --- | --- | --- |
| Application routes + route handlers + metadata routes | 63 | 63 |
| Original-only / updated-only | none / none | |

Handlers (16 `route.ts` files) — exported methods are identical in every file. Identical content: attachments (file/upload), Gmail callback, `cron/cvv-cleanup`, `cron/leads`, `public/crm-inquiry`, `public/sequence-unsubscribe`, `track/quote-open`. Changed content: `cron/sequences`, `cron/tasks`, `health`, `public/contact-inquiry`, `public/lead-capture`, `public/subscribe`, `public/unsubscribe`, `v1/website/flight-inquiries` — each is analysed in the feature/API report. `src/proxy.ts` (session gate and role guards) is **unchanged**; `src/lib/permissions.ts` only gains two predicates (`canBulkDeleteLeadsAndContacts`, `canBulkEnrollInSequence`).

## 7. Classification of every significant difference

| # | Difference | Classification | Evidence |
| --- | --- | --- | --- |
| 1 | Original `src/` tree, routes, exports retained | **Preserved** | sections 5–6 |
| 2 | Sign-in location provenance (2 nullable `Account` columns, `src/server/geo/*`, local DB-IP lookup) | Intentional improvement | additive migration `20261108000100`; documented in `docs/GEOIP.md` |
| 3 | `InquirySubmissionInfo` table + Admin-only masked IP with audited Reveal for both inquiry inboxes | Intentional improvement | migration `20261113000100`; tests |
| 4 | Bulk selection / add-to-sequence / Admin-only bulk delete on Leads and Contacts | Intentional improvement | new permission predicates; tests |
| 5 | Sequence enrollment lifecycle (failed ≠ active, Gmail preflight, bounded retry, unenroll, enroll by status) | Intentional improvement | `sequences.ts`, `due-sequence-steps.ts`, `sequence-enrollment-eligibility.ts`; unit tests |
| 6 | Commissions/Salesboard: previous-period comparison removed; calendar popover | Intentional removal / improvement | documented in `docs/UPDATED_PROJECT.md` and the component comment |
| 7 | Due-work sweeps moved out of `"use server"` modules (`due-sequence-steps.ts`, `due-task-notifications.ts`); signed-in buttons call role-checked wrappers | Intentional replacement | wrappers check `canViewSequencesPage` / `canViewTasks`; cron routes and the in-process poller call the sweeps directly |
| 8 | In-process task poller: new switch `DISABLE_IN_PROCESS_POLLER`, **default still ON** | Intentional improvement | `src/lib/poller-config.ts`; default unchanged |
| 9 | `/api/health`: anonymous answer reduced to `{ "status": "ok" \| "down" }`; detail needs `Bearer CRON_SECRET` | Intentional replacement — **Potential regression for external consumers** | see feature/API report |
| 10 | Marketing-campaign HTML is cleaned on the server (`sanitize-html`, allow-list) at save, preview and send | Intentional improvement — **Potential regression for unusual stored HTML** | `sanitize-campaign-html.ts`; the shipped starters are tested to keep their content |
| 11 | Public JSON/form endpoints bounded (64 KB / 32 KB), 413 on excess | Intentional improvement | `read-limited-json.ts`, `read-limited-form.ts`; tests; measured |
| 12 | Contact inquiry idempotency (`submissionId` → derived id, duplicate/409) | Intentional improvement | `inquiry-id.ts`; unit tests; **PostgreSQL behaviour unverified** |
| 13 | Dependency upgrades (Next 16.4.6, Nodemailer 10, Zod 4.6, Tiptap 3.34) | Intentional improvement | `package.json`/lock; Node 24 image satisfies engines |
| 14 | `X-Powered-By` removed | Intentional improvement | `next.config.ts` |
| 15 | R2 storage module and tests deleted (staged) | Intentional removal | uploads are local-VPS only (documented earlier); no source reference remains except tests asserting its absence |
| 16 | Dockerfile, compose, deploy scripts, CI workflow present in the working tree | **Preserved** (identical to the original's files) — but they exist **only in the index/working tree** (staged `A`), not in `HEAD` | section 9 |
| 17 | `package.json` dev/start port 3001 | Intentional replacement (local) | no Docker/Vercel use |
| 18 | 7 NUL-corrupted original files intact in the update | Intentional improvement (repair) | section 5 |
| 19 | Migration directory set: 73 original + 2 new, same order | **Preserved** + Intentional improvement | database report |
| 20 | 2 hand-merged staged files (`.env.example`, `prisma/schema.prisma`) | Preserved + Intentional improvement | blob comparison; both differences are additive |

**Confirmed regressions: none.** **Potential regressions: #9 (external health consumers), #10 (stored campaign HTML relying on stripped markup), #11 (a caller sending more than 64 KB / 32 KB), #12 (PostgreSQL behaviour of the new idempotency path is unverified).** Unverified items are listed in section 11.

## 8. Latest changes reviewed (all of them)

The complete lists are in Appendices A and B. The changes made after the last known state fall into six groups; each group was read, not only counted.

**A. Test worker cap (`vitest.config.ts`).** `maxWorkers: Number(process.env.VITEST_MAX_WORKERS) > 0 ? that : 4`.
* *Reliable?* Two consecutive full runs on this machine at 4 workers produced identical results: 290 files passed / 28 skipped; **4,003 tests passed / 562 skipped**; the first run took 666 s and the second 674 s (the machine was also running other dev servers and sessions; an earlier run at 3 workers took 208 s, so wall-clock time is load-dependent while the outcome was stable).
* *Configurable?* Yes: `VITEST_MAX_WORKERS=<n>`; it is a cap, not a floor. *Default appropriate?* Yes for an 8 GB / 12-thread developer machine (the stated cause of the contention); on larger machines it only costs speed. *CI?* The CI workflow already runs `npx vitest run --no-file-parallelism`, so the cap is irrelevant there; larger runners can still set the variable.
* *Isolation / masking?* The cap changes only how many files run at once; per-file isolation, `testTimeout` (45 s) and `hookTimeout` (60 s) are unchanged and were already in the original. No test or assertion was changed to achieve it. It cannot hide a failing test; it can hide only contention-induced timeouts.

**B. Migration file test (`src/lib/__tests__/migration-files.test.ts`).** Three static tests: every migration directory has a non-empty `migration.sql` (and more than 70 directories exist); none starts with an `EF BB BF` byte-order mark; every file is valid UTF-8 without NUL bytes or a UTF-16 mark. Verified independently: the current `20261113000100` file starts `2d 2d 20 49` (`-- I`) — **no BOM**, and no migration in either project has one. The predicate is correct (a PostgreSQL scanner treats bytes ≥ 0x80 as identifier characters, so a BOM before the first token is a syntax error). The test reads the real files only, so it has no negative-control fixture proving it would fail on a BOM; that is a (small) gap, not a false claim: its header states it is static and "no database involved". Discovery uses the directory listing; **ordering is not asserted here**; `migration-manifest.test.ts` (which passes) checks that the generated manifest lists exactly the migration folders. The file has one CRLF line inside otherwise LF text (cosmetic; PostgreSQL ignores it; Git normalises it).

**C. Bounded form reader (`read-limited-form.ts`, used only by `POST /api/public/unsubscribe`).** Declared `Content-Length` over 32 KB or malformed → refused before any byte is read; the stream is counted and cancelled at the cap whatever the header says; urlencoded and multipart bodies both parse; an empty or unparseable body returns "unreadable". In the route an oversize/unreadable body becomes the existing "the link is incomplete" response (**HTTP 400**, the same answer the original gave for an unparseable form), **not** a 413 and not a 500 — the validation of token, reason and same-origin check is untouched and runs on the parsed form exactly as before. The five reader tests and five route tests pass. *Other routes?* Evidence-based: the only other body parsers in `src/app/api` are `req.json()` (already replaced by `read-limited-json` in `contact-inquiry`/`crm-inquiry` through `public-inquiry.ts`, `lead-capture`, `subscribe`) and the 32 KB-capped `flight-inquiries`; the Gmail callback and `GET` routes read no body; the attachment upload route streams to disk under its own authorised-size check. **No remaining unauthenticated route buffers an unbounded body.**

**D. Contact idempotency.** The unit tests match the code: id = `c` + 24 hex of SHA-256 over (company, source, key); same key + same content → `{ ok: true, id, duplicate: true }` with the **same id and no second row, no second notification**; same key + different message **or different e-mail** → HTTP 409 and nothing overwritten; e-mail case-insensitive; keys from another company or inbox never collide; malformed key → 400; routes that do not opt in ignore the field; older website builds (no key) behave as before. The websites' current key (`<uuid>.<16-hex>`, 53 characters) satisfies the CRM's `[A-Za-z0-9._-]{8,200}`. Duplicate protection for **activity records** is by construction: `notifyNewInquiry` (the only side effect) runs only for a first insert. **Unverified without a real database:** the advisory-lock serialisation (two simultaneous requests, same key, different content → one 201/409, no deadlock), the primary-key collision behaviour, and the 409 path under real transactions — the corresponding integration file (`public-inquiry-idempotency.integration.test.ts`, 8 tests) is skipped here. Mocked/unit results are **not** evidence of PostgreSQL behaviour.

**E. Other changes read:** `health/route.ts` + `cron-auth.ts` (`hasValidCronSecret`: constant-time, false when the secret is unset), the sweeps and wrappers, `poller-config.ts`, `sanitize-campaign-html.ts` and its call sites, `marketing-campaigns.ts` (`previewCampaignHtml` action, Admin/Marketing only), `request-ip.ts` (carrier-grade-NAT range now treated as non-public), `csp.ts` (dev-only `unsafe-eval`), `next.config.ts`.

**F. Changes from this working session** (disposable-database guard, body caps, local-geolocation fallback, inquiry IP capture, sequence work) are described in `FOUR_PROJECT_COMPARISON_2026-11-13.md`.

## 9. Unintended structural regressions — search results

| Search | Result |
| --- | --- |
| Missing original modules | none (435/435) |
| Changed/removed exports | none removed |
| Broken imports / wrong relative paths | none: `tsc --noEmit` clean, `eslint .` clean, production build succeeds |
| Missing route handlers | none (63 = 63; methods identical) |
| Missing server-only boundaries | the sweeps were moved *out of* `"use server"`, which narrows the public-action surface; unchanged elsewhere |
| Environment-variable requirements | code reads 40 names vs 38; the two new ones (`GEOIP_DB_PATH`, `DISABLE_IN_PROCESS_POLLER`) are optional; none dropped |
| Permissions | additive only; `proxy.ts` unchanged |
| Background workers / schedulers | `cron/{tasks,sequences,leads,cvv-cleanup}` and the in-process poller preserved (poller default ON) |
| Database access patterns | unchanged except the new optional tables/columns; raw SQL in `establish-session.ts` now writes two new columns (requires the migration — database report) |
| Direct database access from the website | none in `Travel Agency Website-updated` (API-only; structural guards pass) |
| Deployment files that exist only in Git's index | **Yes — a condition:** `Dockerfile`, `compose.yaml`, `.dockerignore`, `.gitattributes`, `.github/workflows/ci.yml`, `deploy/*` and others are staged additions (`A`), identical to the original's files on disk but **absent from `HEAD`**. Any deployment that checks out a commit instead of using this working tree would lack them. Also `deploy/ci-smoke.sh` and `deploy/verify.sh` are staged **and** carry newer unstaged edits (`AM`). |
| Runtime dependencies missing from production builds | Checked with a real standalone build: `sanitize-html`, `htmlparser2`, `nodemailer`, `maxmind`/`mmdb-lib` are **bundled into the server chunks** (the MaxMind reader's format strings and the sanitiser's option names were found in `.next/server/chunks`), so their absence from `.next/standalone/node_modules` is expected; `@prisma/*`, `pg`, `next`, `react`, `sharp` are present. The GeoIP *data* file is not code: it is copied into the standalone output only if present at build time (it is git-ignored, so a clean Git build lacks it). |

## 10. Verification (non-production, no database)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | PASS |
| `npx eslint .` | PASS |
| `npx prisma validate` | PASS |
| `npx vitest run` (twice, default config, no environment variables) | PASS both times — 290 files passed, **28 skipped**; 4,003 tests passed, **562 skipped** (database-gated; skipped is not passed) |
| `NEXT_OUTPUT=standalone npm run build` (throw-away database URL, no connection made) | PASS; `.next/standalone/server.js` produced |
| `npm audit --omit=dev` | 29 advisories (1 critical, 17 high, 10 moderate, 1 low), all in build/CLI tooling chains (`@opennextjs/*`, `shadcn`, `prisma` CLI, `proxy-addr` via `express` in OpenNext, `systeminformation`, `glob`…); none in the request path of the application; `next`, `nodemailer`, `sanitize-html`, `maxmind` are not listed (`zod` is listed only because the `shadcn` CLI carries its own nested copy, zod 3.25.76; the application uses 4.6.6) |
| `compose.yaml` parse | PASS as YAML (services `db, app, cloudflared, cvv-cleanup, tools`; no host ports published); `docker compose config` and Dockerfile build **not run** (Docker is not installed) |
| Database-backed tests, migrations, advisory-lock tests, live website contract, browser flows | **DEFERRED / BLOCKED** (no PostgreSQL; deferred by decision) |

**Incident to disclose.** When the build step started, a `next dev -p 3001` server for this project was already listening. I noticed the listener in the same command output and should have stopped before building. The build wrote only under `.next/` (its own output); the running dev server uses `.next/dev`, whose last write was earlier. I did not stop, restart or signal that server. Afterwards it answered every request, including the static `/features`, with HTTP 500. Its own log (`.next/dev/logs/next-development.log`) shows `getOrCreateGlobalAsyncLocalStorage is not a function` / `ensureInstrumentationRegisteredWithDeferredSpans is not a function` starting at the server's first request, 28 minutes after it started (≈07:23 local) — hours before this audit's build (10:52). That is the signature of a Next.js package replaced on disk (16.3.8 → 16.4.6) underneath a dev process that had loaded the old one. So the breakage predates the build and is consistent with the dependency upgrade; the server needs a restart by whoever owns it. I did not do that, per the instruction not to restart existing servers.

## 11. Remaining risks and unverified items

1. Everything that needs PostgreSQL (section 8-D, the two migrations, sign-in raw SQL, inquiry idempotency under concurrency, the 562 skipped tests). **Unverified.**
2. The staged merge is unfinished and 74 files carry unstaged changes on top of it; the final tree has never been committed or built from a clean checkout. **Unverified.**
3. Which version of the files the live VPS runs (the live stack is documented as differing from every pushed branch). **Unverified** — no access.
4. The external consumers of `/api/health` (uptime monitors, dashboards) are unknown.
5. Exported `"use server"` functions without an actor check remain in `lead-queue.ts` (`distributeNewWebsiteLead`, `distributePendingWebsiteLeads`) and the reference-data agent lists take a caller-supplied `companyId`. Reaching them requires an authenticated session (probed earlier: unauthenticated and forged-cookie action posts are redirected to login). **Theoretical, unchanged from the original.**

## 12. Prioritised corrections before deployment

| Priority | Correction | Owner |
| --- | --- | --- |
| P0 | Provide a disposable PostgreSQL, then run the 562 skipped tests, apply the two additive migrations from scratch and on a copy of production-shaped data, run the advisory-lock/idempotency tests and the six website contract tests. | you (deferred) |
| P0 | Resolve the unfinished merge and commit, so the deployment files (`Dockerfile`, compose, deploy scripts, CI) and the 74 unstaged edits exist in a commit; re-run the suite from a clean checkout. | you |
| P1 | Decide how the GeoIP file reaches the container (volume + `GEOIP_DB_PATH`, or accept "Location unavailable"); `compose.yaml` has no mount for it. | you |
| P1 | Check every external reader of `/api/health`; give them `Authorization: Bearer $CRON_SECRET` or accept the minimal answer. | you |
| P1 | Restart the stale `next dev` on port 3001 (running pre-upgrade modules, returning 500). | owner of that session |
| P2 | Add a negative-control fixture to the BOM test; assert migration ordering in `migration-files.test.ts`. | optional |
| P2 | Tooling advisories (`npm audit`) — review with the next dependency window. | optional |
| P3 | Add an actor check to the two `lead-queue` actions or move them out of the `"use server"` module (the same pattern as the sweeps). | optional |

## 13. Decision

**Structural parity: READY WITH CONDITIONS.** The updated CRM is a continuation of the original: every route, every source file, every export, the framework, Prisma architecture, authentication gate, permission model, cron/poller structure, Docker/Compose/CI files and environment-variable contract are preserved; differences are additive or documented replacements; there are no confirmed regressions. Conditions: P0 items above (the merge and the staged-only deployment files are part of "structure" until committed) and the database-dependent items remain unverified.

## Appendix A — tracked files with unstaged changes (relative to the index)

```text
MM .env.example
MM .gitignore
MM README.md
AM deploy/ci-smoke.sh
AM deploy/verify.sh
MM docs/DEPLOYMENT.md
 M docs/SECURITY_POSTURE.md
MM next.config.ts
MM package-lock.json
MM package.json
MM prisma/schema.prisma
 M src/__tests__/csp-nonce.test.ts
 M src/__tests__/security-headers.test.ts
MM src/__tests__/session-enforcement-coverage.test.ts
 M src/app/(crm)/commissions/__tests__/page.test.tsx
 M src/app/(crm)/commissions/page.tsx
 M src/app/(crm)/contacts/page.tsx
MM src/app/(crm)/leads/[id]/page.tsx
 M src/app/(crm)/leads/page.tsx
 M src/app/(crm)/salesboard/__tests__/page.test.tsx
 M src/app/(crm)/salesboard/page.tsx
 M src/app/(crm)/sequences/[id]/page.tsx
 M src/app/(crm)/users/page.tsx
 M src/app/api/cron/__tests__/cron-auth.test.ts
AM src/app/api/cron/__tests__/cvv-cleanup.test.ts
 M src/app/api/cron/sequences/route.ts
 M src/app/api/cron/tasks/route.ts
MM src/app/api/health/__tests__/route.test.ts
 M src/app/api/health/route.ts
 M src/app/api/public/contact-inquiry/route.ts
 M src/app/api/public/lead-capture/route.ts
 M src/app/api/public/subscribe/route.ts
 M src/app/api/public/unsubscribe/route.ts
 M src/app/api/v1/website/flight-inquiries/route.ts
 M src/components/crm/notes-panel.tsx
 M src/components/crm/period-kpi.tsx
 M src/components/crm/report-range-controls.tsx
 M src/components/get-in-touch/inquiry-detail-panel.tsx
 M src/components/get-in-touch/inquiry-detail-view.tsx
 M src/components/leads/customer-info-card.tsx
 M src/components/leads/lead-ip-reveal.tsx
 M src/components/leads/lead-sequences-panel.tsx
 M src/components/sequences/apply-sequence-dialog.tsx
 M src/components/sequences/enroll-leads-dialog.tsx
 M src/components/subscriptions/__tests__/campaign-form-starters.test.tsx
 M src/components/subscriptions/campaign-form.tsx
 M src/components/ui/checkbox.tsx
 M src/instrumentation.ts
 M src/lib/__tests__/request-ip.test.ts
MM src/lib/csp.ts
 M src/lib/migration-manifest.json
 M src/lib/permissions.ts
 M src/lib/prisma.ts
 M src/lib/request-ip.ts
 M src/server/actions/__integration__/session-lifecycle.integration.test.ts
 M src/server/actions/__tests__/sequences.test.ts
 M src/server/actions/__tests__/tasks.test.ts
 M src/server/actions/marketing-campaigns.ts
 M src/server/actions/sequences.ts
 M src/server/actions/tasks.ts
 M src/server/auth/__tests__/sign-in-context.test.ts
 M src/server/auth/establish-session.ts
 M src/server/auth/google-authorization.ts
 M src/server/auth/sign-in-context.ts
 M src/server/email/gmail-send.ts
 M src/server/email/templates.ts
 M src/server/lead-submission-info.ts
 M src/server/public-inquiry.ts
 M src/server/queries/__tests__/reference-data.test.ts
 M src/server/queries/accounts.ts
 M src/server/security/__tests__/ip-capture.test.ts
 M src/server/security/cron-auth.ts
 M src/server/security/ip-capture.ts
 M vitest.config.ts
```
(74 entries; the two-letter code is the Git status: first letter = staged state, second = working-tree state)

## Appendix B — untracked paths

```text
docs/CRM_INDEPENDENCE_SECURITY_AND_FUNCTIONALITY_AUDIT_2026-11-13.md
docs/CRM_RELEASE_BLOCKER_INVESTIGATION_2026-11-13.md
docs/FINAL_PRODUCTION_READINESS_AUDIT_2026-11-13.md
docs/FOUR_PROJECT_COMPARISON_2026-11-13.md
docs/GEOIP.md
docs/ORIGINAL_VS_UPDATED_STRUCTURAL_PARITY_AUDIT.md
docs/UPDATED_PROJECT.md
docs/recovery-archive/
docs/requirements/
prisma/migrations/20261108000100_sign_in_location_provenance/
prisma/migrations/20261113000100_inquiry_submission_info/
scripts/backfill-sign-in-locations.ts
scripts/geoip-database.ts
src/app/api/public/unsubscribe/__tests__/route-body-limit.test.ts
src/components/commissions/
src/components/crm/__tests__/bulk-selection.test.tsx
src/components/crm/__tests__/note-meta.test.tsx
src/components/crm/__tests__/period-kpi.test.tsx
src/components/crm/bulk-enroll-dialog.tsx
src/components/crm/bulk-selection.tsx
src/components/crm/note-meta.tsx
src/components/get-in-touch/__tests__/
src/components/get-in-touch/inquiry-submission-information.tsx
src/components/leads/__tests__/active-sequences.test.tsx
src/components/leads/__tests__/customer-info-card.test.tsx
src/components/leads/active-sequences.tsx
src/components/leads/unenroll-sequence-button.tsx
src/components/sequences/__tests__/
src/lib/__tests__/airport-reference-data.test.ts
src/lib/__tests__/bulk-selection.test.ts
src/lib/__tests__/migration-files.test.ts
src/lib/__tests__/poller-config.test.ts
src/lib/bulk-selection.ts
src/lib/poller-config.ts
src/server/__tests__/inquiry-submission-info.test.ts
src/server/__tests__/lead-submission-info-local-geo.test.ts
src/server/__tests__/public-endpoints-body-limit.test.ts
src/server/__tests__/public-inquiry-idempotency.test.ts
src/server/__tests__/public-inquiry-submission-info.test.ts
src/server/actions/__integration__/bulk-selection.integration.test.ts
src/server/actions/__integration__/public-inquiry-idempotency.integration.test.ts
src/server/actions/__tests__/due-work-authorization.test.ts
src/server/actions/__tests__/inquiry-submission.test.ts
src/server/actions/__tests__/marketing-campaigns-html-lifecycle.test.ts
src/server/actions/__tests__/sequence-status-enroll.test.ts
src/server/actions/bulk-selection.ts
src/server/actions/inquiry-submission.ts
src/server/actions/sequence-status-enroll.ts
src/server/auth/__tests__/sign-in-context-geo.test.ts
src/server/due-sequence-steps.ts
src/server/due-task-notifications.ts
src/server/email/__tests__/sanitize-campaign-html.test.ts
src/server/email/sanitize-campaign-html.ts
src/server/geo/
src/server/inquiry-id.ts
src/server/inquiry-submission-info.ts
src/server/queries/__tests__/inquiry-submission-info.test.ts
src/server/queries/inquiry-submission-info.ts
src/server/security/__tests__/read-limited-form.test.ts
src/server/security/__tests__/read-limited-json.test.ts
src/server/security/read-limited-form.ts
src/server/security/read-limited-json.ts
src/server/sequence-enrollment-eligibility.ts
src/test/__tests__/
src/test/disposable-database.ts
src/test/integration-database-guard.ts
```
(66 entries; the two-letter code is the Git status: first letter = staged state, second = working-tree state)
