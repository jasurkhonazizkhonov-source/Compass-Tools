# Final production-readiness audit - Compass Tools CRM (updated) - 2026-11-13

Audit only. Nothing was fixed, deployed, restarted, committed, staged, stashed or merged; no migration was run; no database was created, contacted or modified;
no production credential, e-mail or SMS was used. Companion reports: the website audit (`Travel Agency Website-updated/docs/FINAL_PRODUCTION_READINESS_AUDIT_2026-11-13.md`)
and the joint report (`Travel Agency Website-updated/docs/JOINT_WEBSITE_CRM_RELEASE_READINESS_2026-11-13.md`).

## Decision

**NOT READY.** Two critical blockers prevent a safe release of this working tree, independent of how good the code is:

1. **The release source is not a reviewed commit.** The repository is in an unfinished merge (`MERGE_HEAD c6b8d8e`), 79 entries are staged, 73 files have further unstaged edits and 95 are untracked - including both new database migrations. `HEAD` itself contains **no** `Dockerfile`, `compose.yaml`, `.dockerignore` or `deploy/` directory: they exist only as staged additions of the in-progress merge. `deploy/deploy.sh` refuses an unclean checkout and refuses any ref that is not already on `origin/main`.
2. **A new migration may fail to apply.** `prisma/migrations/20261113000100_inquiry_submission_info/migration.sql` starts with a UTF-8 byte-order mark (it is the only one of the 75 migration files that does). PostgreSQL's scanner treats the BOM as an identifier character, so the first statement can be rejected ("syntax error at or near" the BOM) and `prisma migrate deploy` would stop. This is **unverified** (no disposable database is authorised) but credible; it must be tested, or the file re-saved without a BOM before it is committed (it has not been applied anywhere, so editing it is safe at this point).

After those two are resolved the CRM would be **READY WITH CONDITIONS** (database-backed behaviour and the Docker build still unverified; section 16).

## 1. Project identity and baseline

| | Updated CRM (release candidate) | Original CRM (reference, never started) |
|---|---|---|
| Folder / port | `F:\Claude Workspace\compass-tools-updated` / 3001 | `F:\Claude Workspace\compass-tools` / 3000 (not listening) |
| Branch / HEAD | `work/commission-salesboard-notes-ui` / `5a77976` ("Merge pull request #1 ... website-api-minimal") | Git unreadable: `.git/config` is 1,034 zero bytes since 2026-10-21 (not repaired, not relied on) |
| Merge state | **in progress**: "All conflicts fixed but you are still merging"; `MERGE_HEAD c6b8d8e` ("Fix Cloudflare token variable in CI smoke test"), merge base `2daf3f6`; 0 unmerged entries; no conflict markers in the tree | n/a |
| Staged | **79** (34 added, 41 modified, 4 deleted); 15 files also carry unstaged edits | n/a |
| Unstaged / untracked | 73 / 95 | n/a |
| Stash | 1 (`pre-merge: UI dev-CSP change (src/lib/csp.ts)`) | n/a |
| Index file SHA-256 (prefix) | `3422053116ff4701` (identical to the previous task's start) | `7dc984c2987b79eb` |
| Env files (names) | `.env.example` | `.env` (not read), `.env.example` |
| Stack | npm 11; next **16.4.6**, react 19.2.8, Prisma **7.9.1** (+ adapter-pg), nodemailer 10.1.4, zod 4.6.6, sanitize-html 2.18.1; Node 24.19.0 locally, Docker pins `node:24.21.0-bookworm-slim@sha256:...` | next 16.3.8 |
| Hashes | inventory of 1,042 non-generated files; original CRM: 951 files, **0 differences** against the baseline taken in the earlier task |  |

**Does the merge state block a reliable release?** Yes (section Decision, item 1). The working tree is not a commit, so a release built from it could not be reproduced or deployed by the project's own script. Safest resolution for your approval (not performed): review the staged merge result and the unstaged edits, commit the merge (`git commit`) and then the remaining work as one or more reviewed commits, push, merge to `origin/main`, deploy that commit with `deploy/deploy.sh --ref <sha>`. Aborting the merge would discard the staged Docker/deploy assets and is not recommended.

## 2. Architecture comparison with the original CRM

File-level (independent of Git): 951 original files, 1,042 updated; 855 identical, 92 different, **4 original-only** (`.env`, `skills-lock.json`, and two zero-byte stray files named `client` and `server` in the project root), 95 updated-only. Nothing functional exists only in the original.

| Area | Finding |
|---|---|
| Differences (92) | geolocation of sign-ins and inquiries (`src/server/geo/*`, `sign-in-context`, `inquiry-submission-info`, two migrations); bulk selection / bulk enroll (additive permissions); commissions / salesboard / reports UI; website contact idempotency; campaign sanitizer; health minimisation; process-due split; CSP dev-eval; CGNAT address rule; dependency updates; vitest DB guard |
| Permissions | `src/lib/permissions.ts`: **additions only** (`canBulkDeleteLeadsAndContacts` Admin-only, `canBulkEnrollInSequence`); no existing rule changed |
| Authentication | session establishment now also stores sign-in location provenance (2 new nullable columns); verification, session revocation and single-device rules unchanged; `session-enforcement-coverage` test passes |
| Security middleware | `proxy.ts` unchanged; `lead-capture` now reads its body through the bounded reader; `cron-auth` gains a strict, read-only secret check |
| Removed code | only lines moved by the process-due split (`sequences.ts`, `tasks.ts` -> `due-*.ts`, code verbatim) |
| Calling / SMS integrations | none exist in either project (searched source, schema and `package.json`) |

Functional areas inspected by file set and by the full suite: authentication, roles, leads, contacts, companies, users, activities, tasks, campaigns/marketing, reports, search/filters, bulk actions, email (Gmail send), notifications, cron routes (`leads`, `tasks`, `sequences`, `cvv-cleanup`), file uploads (local disk), Prisma models, 76 migrations (74 original + 2), API routes, server actions, health, deploy scripts, backups. **No functionality was found missing or unintentionally regressed.**

## 3. Preserved functionality

All areas above remain present with identical route and component sets. 314 test files cover them; 3,989-3,990 tests pass depending on the run (section 9).

## 4. Improvements verified (source and tests)

| # | Improvement | Status | Evidence |
|---|---|---|---|
| 1 | Campaign HTML sanitised at save, preview and email build | present | `sanitize-campaign-html.ts` (parser-based allow-list); called in `createMarketingCampaign`, `updateMarketingCampaign`, `previewCampaignHtml`, `buildMarketingCampaignEmail`; 57 + 5 tests |
| 2 | Sandboxed campaign preview | present | `campaign-form.tsx`: `<iframe sandbox="" srcDoc>` with its own CSP; no `dangerouslySetInnerHTML` left. **Not observed in a browser** (no CRM login; 3001 is down) |
| 3 | Contact idempotency | present; **database behaviour unverified** | `public-inquiry.ts`, `inquiry-id.ts`, route opt-in `acceptSubmissionId`; 14 mocked-DB tests |
| 4 | Anonymous `/api/health` minimal | present in code; **not observed live** | `{status}` + code; tests |
| 5 | Authorised full readiness | present | `Authorization: Bearer <CRON_SECRET>`; `verify.sh` / `ci-smoke.sh` send it from inside the container; the Docker healthcheck needs only `status: ok` and is unaffected |
| 6 | `X-Powered-By` removed | present in config; **not observed live** | `poweredByHeader:false`; the built `required-server-files.json` carries it |
| 7 | Role-checked process-due actions | present | `due-task-notifications.ts`, `due-sequence-steps.ts`; wrappers check `canViewTasks` / `canViewSequencesPage`; cron routes and poller call the sweeps |
| 8 | Rate limiter | reviewed, unchanged by design | authenticated website API budget fails closed; public per-IP limiter fails open without a trusted IP (see 13) |
| 9 | Production poller | default ON (the VPS relies on it); opt-out `DISABLE_IN_PROCESS_POLLER` | `instrumentation.ts`, `poller-config.ts` |
| 10 | Dependency updates | present | versions above; section 7 |

## 5. Missing or regressed functionality

None found.

## 6. Source and configuration integrity

* **Not a commit** (Decision, item 1). Release content exists only as staged merge + working-tree edits; the two new migrations and the new source files are untracked.
* `package.json` and `package-lock.json` are staged **and** modified in the working tree (`MM`); the staged versions are the older ones. A commit must take the working-tree versions or the build will not match what was tested.
* Line endings: working tree is CRLF throughout (Windows checkout); the Linux VPS checkout will be LF. Prisma checksums are computed from the file on the VPS, so this is harmless **provided the migration is committed without a BOM**.
* Generated Prisma client (`src/generated`) is git-ignored and regenerated by the Dockerfile (`postinstall` + `npx prisma generate`).
* The 121 MB GeoIP database (`data/geoip/city.mmdb`) is git-ignored and **not** copied into the image or mounted by `compose.yaml`: sign-in and inquiry locations will be empty in production until it is provisioned (graceful, not a failure; `docs/GEOIP.md`).

## 7. Dependency and security findings

`npm audit` (read-only): **38** findings (1 critical, 18 high, 18 moderate, 1 low) - down from 71. Lockfile consistent (`npm ls --all` exit 0). The installed `next` (16.4.6), `nodemailer` (10.1.4), `zod` (root 4.6.6), `sanitize-html` (2.18.1) and Tiptap/ProseMirror (3.34.0 / 1.42.9) are past the advisory ranges that were flagged earlier.

* `npm audit --omit=dev`: 29 findings, because `shadcn`, `@opennextjs/cloudflare` and `wrangler` are declared under `dependencies`. All 29 sit in the **CLI/build chains** of those packages (shadcn -> MCP SDK -> express/`body-parser`/`proxy-addr`, nested `zod`, `hono`; opennext/wrangler -> `undici`, `glob`, `minimatch`; Prisma CLI -> `@prisma/config`, `mysql2`, `deepmerge-ts`, `js-yaml`).
* **Affects production runtime:** none identified - no source or script imports any of them, and the runner image is a Next standalone bundle (traced imports only). *Caveat:* a CRM standalone build/Docker build was not run, so runtime-image tracing is inferred, not observed. The `tools` image (migration job, on demand) does contain the Prisma CLI chain; its flagged items concern MySQL and CLI use, not the PostgreSQL migration path.
* **Dev/test tooling only:** `vitest`/`vite` (high), `typescript-eslint` family.
* **The one "critical" (`proxy-addr`, via the shadcn CLI) is not reachable at runtime.**
* **Release blocker?** No. Recommended follow-up: move `shadcn`, `@opennextjs/cloudflare` and `wrangler` to `devDependencies`, update `vitest`/`vite` within range, re-audit.
* Website dependency tree is independent of this one (separate lockfiles).

## 8. Build results

`tsc --noEmit` 0 errors and ESLint 0 problems (re-run in this audit). `npm run build` (plain `next build`) succeeded earlier today after the final dependency set (exit 0; 3 pre-existing Turbopack tracing warnings); no source file is newer than that build (verified). **Not run:** the Docker-mode build (`NEXT_OUTPUT=standalone` + `prisma generate`, as in the Dockerfile) - Docker is not installed here and a standalone CRM build was not made. Build success is not treated as readiness.

## 9. Test results

| Run | Files | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| Final run earlier today (two runs) | 314 | 4,544 | 3,990 | 0 | 554 |
| This audit, run alone | 314 | 4,544 | 3,989 | **1** (`quote-builder-gds-tabs`, a jsdom UI test) | 554 |
| This audit, first run, with other commands running at the same time | 311 | 4,462 | 3,905 | 3 + 4 file-level crashes ("child process was torn down", a transient module-resolution error) | 554 |

The failing tests pass when run alone (the seven files from the crashed run: 129/129; `quote-builder-gds-tabs` 8/8 three times in a row), so these are **timing/worker-load flakes on this machine, not defects** - but the suite is **not deterministic** under load and must not be described as "clean". Re-run on an idle machine or in CI before release.

**Skipped (554), by cause:** 551 require PostgreSQL (26 `__integration__` files = 529 tests; plus `reference-data.test.ts` 22), gated by `INTEGRATION_DATABASE_URL` and the fail-closed disposable-database guard (`src/test/integration-database-guard.ts`: loopback literal, database named `compass_test`); 3 are OS-conditional file-permission tests in `storage/local.test.ts`. The guard was not bypassed and no database was created. These 551 are **not run**, not passed.

## 10. Database and migration requirements

* Original CRM: 74 migrations; updated: **76**. New (both untracked, additive only, no backfill, no destructive statement):
  * `20261108000100_sign_in_location_provenance` - `ALTER TABLE "Account" ADD COLUMN` x2 (nullable `TEXT`, `TIMESTAMP(3)`).
  * `20261113000100_inquiry_submission_info` - `CREATE TABLE "InquirySubmissionInfo"`, a **unique index** on `inquiryId`, a foreign key to `"ContactInquiry"` (`ON DELETE CASCADE`). **Carries a UTF-8 BOM** (blocker 2).
* `20261016000100_lead_ingest_fingerprint` (the website API's idempotency table) is in both projects; the website audit earlier reported the production database at 72 migrations "when last reported", so up to 4 migrations may be pending there. **Production state is unknown**; nothing was inferred or contacted.
* Code that needs them: sign-in writes the two Account columns (sign-in would fail if the migration were missing); every new contact inquiry writes `InquirySubmissionInfo` (inquiries would fail with a missing-table error). Starting the new app before migrating is therefore harmful. `deploy.sh` already stops on pending migrations unless `--migrate` is given, takes a verified backup first, and runs only `prisma migrate deploy` (forward-only). No seed or data migration is required.
* Recent migrations since 20261001 contain one `DROP INDEX "Attachment_leadId_idx"` (replaced in `20261007000100_lead_attachments_r2`, already part of the deployed line in the original CRM) and in-place data refreshes (`airline_reference_refresh`); none is new in this release.
* Rollback limits: both new migrations are additive, so the **previous application image keeps working** against the migrated database (it ignores the extra columns/table). Rolling the schema itself back is manual (`DROP TABLE`/`DROP COLUMN`) and only needed if the new migration must be undone; restoring the pre-migration backup is the supported path (`deploy/restore-db.sh`).

**Verified vs assumed vs unknown.** Verified: migration contents and order, deploy-script behaviour. Assumed: that the production database is at, or near, the original CRM's 74-migration state. Unknown: the real applied-migration list, data volume, existing duplicate rows. Pre-deployment checks: `prisma migrate status` against production (read-only), a fresh verified backup, a dry run of both new migrations on a disposable copy.

### Contact idempotency - what must be verified against PostgreSQL

The advisory-lock + derived-primary-key design cannot be proven by mocks. Required checks in an authorised disposable database:
1. `pg_advisory_xact_lock(hashtextextended(...))` executes inside Prisma's interactive `$transaction` on the `@prisma/adapter-pg` connection (same session as the following reads/writes).
2. Two concurrent identical requests serialise: exactly one `ContactInquiry` row, one `duplicate:true` reply, one staff notification.
3. Concurrent requests with the same key but different content: one stored, one `409`, no deadlock (locks are taken in a fixed order: content, then key) and no unhandled `P2002`.
4. The explicit-id insert (`"c"` + 24 hex) coexists with cuid-generated ids; no collision with existing rows.
5. Reading the committed row after the lock returns it under the default `READ COMMITTED` isolation.
6. The nested `submissionInfo` create succeeds in the same insert, and `ON DELETE CASCADE` behaves.
7. Lock wait versus the interactive-transaction timeout (a slow holder must produce a retryable failure, not a half-written row).
8. The same checks for the flight API's `LeadIngestFingerprint` primary-key/idempotency path.

## 11. API integration compatibility

Checked field by field against the website's real request builders: see the website report, section 11 (flight inquiry, contact, subscribe: **compatible**). CRM-side facts: flight API requires `Authorization: Bearer` (>= 32-char key, constant-time compare, a second key `WEBSITE_API_KEY_NEXT` for rotation), `Idempotency-Key`, `application/json`, 32 KB cap, strict body, the company fixed by `WEBSITE_API_COMPANY_ID` (default `default-company`), failed-auth counter then 429, request budget 120/min, signed visitor context (`LEAD_INGEST_SECRET`, 5-minute window). Public contact/subscribe take `companyId` in the body, read through a 64 KB bounded reader, with per-IP limits that **fail open** when no trusted client IP exists - true for every website-mediated call on the private network, so those limits are effectively the website's own. Not tested live (no isolated CRM with a database): **blocked / not run**.

## 12. Docker and VPS compatibility

* `compose.yaml` (project `compass-tools`): services `db` (PostgreSQL, no published port, volume `postgres_data`, network `data`), `app` (`expose: 3000`, networks `data`, `web`, `website_api` with alias `compass-crm`), `cloudflared` (`web`), `cvv-cleanup` (`web`), `tools` (migration job, `restart: "no"`); `data` and `website_api` are `internal: true`; restart policy `unless-stopped`; hardening (`cap_drop`, `security_opt`, log rotation); memory limit 1,536 MB.
* Dockerfile: pinned image, `npm ci`, `prisma generate`, standalone build, non-root runner, healthcheck `scripts/healthcheck.mjs` (still valid with the minimal `/api/health`), `tools` target runs `prisma migrate status`.
* Environment names the stack needs (values not read): `APP_BASE_URL`, `POSTGRES_PASSWORD` (+ optional user/db), `CRON_SECRET` (mandatory), `TRUSTED_PROXY` (fixed to `cloudflare` by compose), `LEAD_INGEST_SECRET`, `WEBSITE_API_KEY`, `WEBSITE_API_KEY_NEXT`, `WEBSITE_API_COMPANY_ID`, `WEBSITE_API_ALLOW_PUBLIC_ROUTE`, `UPLOAD_*`, Gmail/Google sign-in settings, the Cloudflare tunnel token. `DISABLE_IN_PROCESS_POLLER` is optional and not wired in compose.
* Background work in production: the in-process 60-second task poller (on), `cvv-cleanup`, and systemd timers (`compass-tools-backup`, `compass-tools-maintenance`) - all pre-existing. A new image start restarts the poller; claims are atomic, so no duplicate notifications.
* `deploy/deploy.sh`: clean checkout, fast-forward from `origin/main` only, build `app` and `tools`, `prisma migrate status` (stops unless `--migrate`; backup first), start, `wait_healthy`, `verify.sh`, keep 5 images; images are tagged with the commit id so `deploy/rollback.sh <tag>` can return.
* Compatible with the website's compose (names, alias, internal networks) - section 12 of the website report.
* **Not compatible with the older layout:** the original website, and the VPS notes, refer to a network `compass-tools_internal`; this compose defines `data`, `web` and `website_api` instead. If the live stack was created from an older compose, redeploying this one creates new networks and the currently live website loses its route to PostgreSQL and to the tunnel.

## 13. Production operational risks

* Releasing from a non-commit, or with the BOM migration unverified (Decision).
* `app` starting before migrations (guarded by `deploy.sh`).
* The live website (original architecture) and the new CRM network layout (section 12) - an ordering/downtime risk handled in the joint plan.
* GeoIP data absent in the container (functional gap, not an outage).
* CRM-side public rate limits are ineffective for website traffic (fail open without a trusted IP).
* Test-suite non-determinism under load.
* A local development server on 3001 currently answers HTTP 500 (see 15).
* Duplicate submissions during cut-over: flight requests are idempotent at the CRM; a contact resend during a window with an older CRM can store twice.

## 14. Rollback requirements

Application: `deploy/rollback.sh <previous tag>`; the previous image remains valid against the migrated database (both new migrations are additive). Database: only by restoring the verified pre-migration backup (`restore-db.sh`), which also discards data written since; no automated down-migration exists. Keep the previous image tag and the backup file name in the release notes. Rolling back the application does **not** roll back migrations.

## 15. Local server state (not restarted)

`3001` is occupied by PID 9836 (`node ... compass-tools-updated\node_modules\next\dist\server\lib\start-server.js`) and answers HTTP 500 on `/login` and `/api/health` ("ensureInstrumentationRegisteredWithDeferredSpans is not a function"): the process predates the `next` 16.3.8 -> 16.4.6 update and is running mismatched files. It needs a restart, which was not done (approval required). 3000 is free and was not started; 3100 and 3101 belong to the website projects.

## 16. Outstanding blockers

| Severity | Item |
|---|---|
| **Critical** | Release source is an unfinished merge + uncommitted work, with Docker/deploy assets only staged (needs your approval to commit) |
| **Critical (unverified)** | BOM at the start of `20261113000100_inquiry_submission_info/migration.sql` may make `prisma migrate deploy` fail |
| High | Contact idempotency and the website API idempotency are unverified against PostgreSQL; 551 database tests not run |
| High | Docker build not run; CRM standalone image never built here |
| High | Production migration state unknown (up to 4 pending) |
| Medium | VPS network layout (`compass-tools_internal` vs `data/web/website_api`) unverified; health/`X-Powered-By`/preview not observed live; suite flaky under load; GeoIP data not provisioned; CRM public rate limits fail open for website traffic |
| Low | 38 npm advisories in tooling chains; stray empty `client`/`server` files in the original CRM; CRLF working tree |

## 17. Exact recommendations

1. Approve and perform the merge commit and the follow-up commits; strip the BOM from the new migration before it is committed.
2. In an authorised disposable PostgreSQL (`compass_test`, via the existing guard), run the 26 integration files plus targeted tests for section 10's list; run both new migrations from the production-like state.
3. Build the Docker image (CI or the VPS) and run `deploy/preflight`/`verify` read-only checks.
4. Take a verified backup; read the production migration status (read-only); deploy with `deploy.sh --ref <sha> --migrate` in the agreed window.
5. Restart the local 3001 server (with your approval) and observe `/api/health`, `X-Powered-By` and the campaign preview.
6. Follow-ups: move CLI tooling to `devDependencies`, provision GeoIP data if sign-in locations are wanted, re-run the suite on an idle machine.


---

# 18. Update — 2026-11-13 (evening): final production-readiness investigation

This section was added to the report above after a further, read-only investigation. Nothing earlier in this file was edited. Evidence and detail: `CRM_DATABASE_AND_DEPLOYMENT_COMPATIBILITY_AUDIT.md`, `CRM_FEATURE_AND_API_COMPATIBILITY_AUDIT.md` (each ends with a dated "final investigation" section) and the classified list in **`CRM_FINAL_RELEASE_BLOCKERS_2026-11-13.md`**.

## 18.1 State preserved

Verified at the start and end: branch `work/commission-salesboard-notes-ui`, `HEAD 5a77976`, `MERGE_HEAD c6b8d8e`, index SHA-256 `3422053116FF4701…9649BEC` (unchanged all day), 79 staged entries (73 byte-identical to `MERGE_HEAD`, 2 hand-merged — `.env.example`, `prisma/schema.prisma` — and 4 R2 deletions), 74 tracked files with unstaged edits, 68 untracked paths, `stash@{0}` "pre-merge: UI dev-CSP change" intact. No Git state-changing command was run; the original CRM was not touched; no process of mine remains running and no existing process was stopped or restarted; the `next dev` on port 3001 was left as found (still returning HTTP 500 from module-mismatch errors that began at its first request, long before any build of this investigation).

## 18.2 What changed in this investigation

* New tests only: `src/server/email/__tests__/campaign-html-fixtures.test.ts` (16, sanitiser compatibility) and `src/server/security/__tests__/body-limit-headroom.test.ts` (5, request-size headroom). Both pass; `tsc` and `eslint` clean.
* One documentation correction: `docs/SECURITY_POSTURE.md` (unstaged file) — the three sentences that described a public detailed `/api/health` now say anonymous callers get only `status` and the detail needs the cron secret.
* New report `CRM_FINAL_RELEASE_BLOCKERS_2026-11-13.md`; dated sections appended to the two compatibility reports and to this one.
* **No source behaviour, schema, migration, configuration, guard, dependency or infrastructure file was changed.** Staged files were not edited.

## 18.3 Findings

| Topic | Result |
| --- | --- |
| Migrations | Prisma's offline diff from the original schema to the updated schema reproduces the two migrations statement for statement and nothing else; current files have no BOM; additive and backward-compatible; **never executed — Unverified** |
| Staged-deployment order | the new image on an un-migrated database breaks every sign-in, the Users page and any public inquiry with IP data; migrate first (the deploy script does); old image on the new schema is safe; backup required (scripted), no maintenance window needed by the schema, no CRM/website coordination needed |
| `/api/health` | HTTP semantics unchanged; anonymous body minimal; in-repository readers updated; external readers **unverified**; no monitor config in the repository |
| Campaign sanitiser | legitimate editor, newsletter and pasted-Word content stays readable; hostile content removed; documented limits (`<font>`, float/flex/shadow); no change needed |
| Request-size limits | caps have ≥ 2–3× headroom over the largest genuine requests; enforced before parsing; fail safely; no change |
| GeoIP | optional, gracefully absent, intentionally excluded from the image; delivery needs a read-only host mount + `GEOIP_DB_PATH` (VPS inspection + approval) |
| Release structure | deploy tooling is **not on `main`**; `origin` push is disabled; merge unfinished; `deploy.sh` needs a clean checkout, a target on `origin/main`, fast-forward only |
| Lead-queue actions | low severity, unchanged from the original, authenticated-only; minimal compatible fix is not minimal; not changed |
| Test reliability | cap default 4, override works, CI serial, no test or assertion removed, skipped tests visible |
| Runtime | Docker still absent; standalone production server verified locally without Docker |
| **New risk** | the guard's live address check can refuse a Docker-hosted disposable database (and the repository's CI) — **needs your decision before pushing** |
| Secrets | none found in 991 tracked/untracked text files |

## 18.4 Final readiness decisions

| Area | Decision |
| --- | --- |
| Structural parity | **READY WITH CONDITIONS** |
| Functional compatibility | **READY WITH CONDITIONS** |
| Database compatibility | **NOT VERIFIED** |
| Runtime compatibility (container) | **NOT VERIFIED** |
| Deployment compatibility | **NOT VERIFIED** |
| GitHub release readiness | **READY WITH CONDITIONS** for pushing a *review branch* so the repository's CI can supply the database and Docker evidence; **NOT READY** to merge to `main` or deploy |

## 18.5 Remaining blockers by what unblocks them

* **Fixable locally, after your approval:** complete and commit the merge; decide the guard/CI question; optional lead-queue hardening; correct the two staged deployment guides; optional test additions.
* **Need an authorised disposable PostgreSQL** (a local one you install, or the CI after a push): every database-backed item and the Docker image build.
* **Need read-only VPS inspection:** live compose/env/network/volume layout, checked-out commit and cleanliness, production migration status, GeoIP file, external health readers, backup state.
* **Need explicit approval:** a push remote, GeoIP mount, health-contract choice, restarting the stale dev server.
* **Need legal/security review:** visitor-IP retention and the websites' privacy wording; the Lead IP Reveal grant policy; GeoIP licence.

The proposed release sequence is in `CRM_FINAL_RELEASE_BLOCKERS_2026-11-13.md`, section 4. No GitHub update and no deployment was made or authorised in this task.
