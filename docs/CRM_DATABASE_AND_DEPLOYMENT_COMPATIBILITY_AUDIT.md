# Compass-Tools — database, migration and deployment compatibility audit (original vs updated)

Date: 2026-11-13. **Static analysis only.** No database was contacted or created (PostgreSQL integration testing is deferred by decision), no migration was run, no container or server of the CRM was started, no production service was contacted, no environment variable or compose file was changed. The original CRM's `.env` (remote database) was not opened. Companion reports: `ORIGINAL_VS_UPDATED_STRUCTURAL_PARITY_AUDIT.md`, `CRM_FEATURE_AND_API_COMPATIBILITY_AUDIT.md`.

Decision for this report — **Deployment compatibility: NOT VERIFIED** (section 9). The database change is additive and the infrastructure files are identical to the original's, but nothing here has been executed against PostgreSQL, and the live VPS configuration cannot be inspected from this machine.

## 1. Schema comparison (`prisma/schema.prisma`)

| Measure | Original | Updated |
| --- | --- | --- |
| Models / enums | 49 / 35 | 50 / 35 |
| Indexes and unique constraints (`@@index`, `@@unique`, `@unique`) | 150 | 151 |
| Datasource / generator | `postgresql`, `prisma-client`, preview `relationJoins` | identical |
| Prisma and adapter versions | `prisma`/`@prisma/client`/`@prisma/adapter-pg` ^7.9.1 | identical |
| Database extensions | none declared | none declared |

Complete list of differences (line-ending and comment differences excluded):

| Change | Kind | Effect on existing rows |
| --- | --- | --- |
| `Account.lastSignInLocationSource String?`, `Account.lastSignInLocationAt DateTime?` | two nullable columns, no default | none: existing rows read as NULL ("not recorded") |
| `model InquirySubmissionInfo` (id cuid, `inquiryId` unique, IP/version/city/region/country/countryCode/timeZone/geoSource nullable, `capturedAt` default now) with `onDelete: Cascade` to `ContactInquiry` | new table | none: starts empty; deleting an inquiry deletes its row |
| `ContactInquiry.submissionInfo InquirySubmissionInfo?` | back-relation only (no column) | none |
| `model LeadIngestFingerprint` | moved within the file, content identical | none |

No column, table, enum value, default, constraint or index of the original was removed, renamed, retyped or tightened. The two hand-merged staged files that carry this (`prisma/schema.prisma`, `.env.example`) differ from `MERGE_HEAD` only by these additions.

## 2. Migration history

| Check | Result |
| --- | --- |
| Directories | original **73**, updated **75** (the earlier "74" counted `migration_lock.toml`) |
| Shared migrations | 73 of 73 present; same names, **same order** (identical prefix) |
| Content of shared migrations | after normalising line endings and any BOM: **identical for all 73** (1 byte-identical, 72 differ only by checkout line endings) — i.e. nothing already applied in production was edited |
| `migration_lock.toml` | identical (`provider = "postgresql"`) |
| New | `20261108000100_sign_in_location_provenance`, `20261113000100_inquiry_submission_info` — both sort after every original migration |
| BOM / NUL / UTF-16 mark in any migration | **none in either project** |
| Manifest | `src/lib/migration-manifest.json` regenerated; `migration-manifest.test.ts` passes (it checks that the manifest lists exactly the folders under `prisma/migrations`) |

Line endings: the working trees are CRLF through `core.autocrlf`; Git stores LF, and a Linux image build from Git sees LF in both projects. Prisma records a checksum per applied migration; since the Git-stored bytes of the 73 shared migrations are unchanged, no checksum drift is introduced. (**Unverified against the production `_prisma_migrations` table** — it was not read.)

### Classification

| Migration | SQL | Class | Notes |
| --- | --- | --- | --- |
| 73 shared | unchanged | Preserved (already applied) | — |
| `20261108000100_sign_in_location_provenance` | `ALTER TABLE "Account" ADD COLUMN "lastSignInLocationSource" TEXT, ADD COLUMN "lastSignInLocationAt" TIMESTAMP(3);` | **Additive and backward-compatible** | nullable, no default, no rewrite, no backfill; a metadata-only change on current PostgreSQL |
| `20261113000100_inquiry_submission_info` | `CREATE TABLE "InquirySubmissionInfo" (…)`, a unique index, an `ADD CONSTRAINT … FOREIGN KEY … ON DELETE CASCADE` to `"ContactInquiry"("id")` | **Additive and backward-compatible** | the foreign key takes a brief lock on `ContactInquiry`; the table is empty so validation is instant |
| Destructive / data-transforming / potentially breaking | **none** | — | — |
| Whether either applies cleanly to a real database | — | **Unverified** | never executed; the SQL was earlier compared with Prisma's own generated SQL for the model (identical statements) and `prisma validate` passes, which is static evidence only |

**Can the updated CRM run against the existing production database without losing, overwriting or misinterpreting data?** Schema-wise yes: the change is expand-only. Operationally it depends on order: the new application code reads and writes the new columns/table (`establish-session.ts` runs a raw `UPDATE "Account" … "lastSignInLocationSource" …` on every sign-in; inquiry creation inserts the nested `submissionInfo`). **If the new image starts before the migrations are applied, sign-in and new inquiries fail.** The existing procedure already prevents that: `deploy/deploy.sh` stops on pending migrations unless `--migrate` is given, takes a verified backup first, then runs only `prisma migrate deploy` (forward-only; never resets or drops), and only then starts the new image. Rolling back to the previous image after the migrations is safe because the previous code ignores nullable columns and an unused table (expand-only). Rolling the *schema* back is not provided and not needed.

## 3. The BOM issue in `20261113000100_inquiry_submission_info/migration.sql`

* **Current file:** starts with the bytes `2d 2d 20 49` (`-- I`). **There is no byte-order mark.** Size 1,329 bytes; valid UTF-8; no NUL; one CRLF line inside otherwise LF text (cosmetic — PostgreSQL ignores it and Git normalises it).
* **Was the proposed correction necessary?** The defect was real in principle: PostgreSQL's scanner treats bytes ≥ 0x80 as identifier characters, so `EF BB BF` before the first token becomes a stray identifier and the file is rejected with a syntax error; the file is written by Windows tools that add a mark silently. It has **already been corrected** (the test's header says the file "had one before it was removed"), so **no further change is required** — and none was made by this audit.
* **Does the correction affect the manifest or checksums?** The manifest test passes against the current bytes. The migration has never been applied anywhere, so there is no recorded checksum to disagree with.
* **Tests:** see 4.

## 4. Migration-related tests — do they overstate verification?

| Test | What it really checks | Overstatement? |
| --- | --- | --- |
| `src/lib/__tests__/migration-files.test.ts` (3 tests) | every migration folder has a non-empty `migration.sql` (>70 folders); no UTF-8 BOM; no NUL / UTF-16 mark / invalid UTF-8 | **No**: the header states "Static checks on the migration files themselves (no database involved)". It reads only the real files, so there is no negative-control fixture proving it would fail on a BOM, and it does not assert ordering. |
| `src/lib/__tests__/migration-manifest.test.ts` | the manifest lists exactly the migration folders | No |
| `scripts/__integration__/vercel-build.integration.test.ts` | the deploy-time schema recovery against a real server | Skipped here — not counted as a pass |
| `src/server/actions/__integration__/*` (25 files incl. the inquiry-idempotency integration) | behaviour on PostgreSQL | **Skipped — not counted as a pass**; 562 tests skipped in the full run |
| Disposable-database guard tests (62) | the guard's accept/refuse rules with a fake client | No claim about a real server; the guard is inactive unless `INTEGRATION_DATABASE_URL` is set |

Nothing in the repository's test names or comments claims PostgreSQL verification that was not performed. **Database behaviour of both migrations remains unverified.**

## 5. Infrastructure and deployment comparison

Identical (after line-ending normalisation) in both projects: `Dockerfile`, `compose.yaml`, `.dockerignore`, `.gitattributes`, `.github/workflows/ci.yml`, `wrangler.jsonc`, `open-next.config.ts`, `vercel.json`, every `deploy/*.sh` except the two below, `deploy/systemd/*`, `scripts/healthcheck.mjs`, `scripts/cvv-cleanup-scheduler.mjs`.

| Aspect | Result |
| --- | --- |
| Base image / build targets | `node:24.21.0-bookworm-slim` pinned by digest; stages `base → deps → builder → tools → runner`; the last stage is the default; identical |
| Startup command | runner: `node server.js` (`PORT=3000`); the `tools` target runs `prisma migrate status`; identical. `npm start` is not used (so the package.json port change to 3001 does not affect containers) |
| Services / names | `db`, `app`, `cloudflared`, `cvv-cleanup`, `tools`; identical |
| Networks | `web` (cloudflared, cvv-cleanup ↔ app), `data` (db), a website-API network exposing the app as `compass-crm:3000`; no service publishes a host port; identical |
| Volumes | `compose.yaml` is file-identical to the original's, so the volume definitions are identical (their live counterparts were not inspected) |
| Health checks | image `HEALTHCHECK` → `scripts/healthcheck.mjs` → `/api/health`, which accepts only `status: "ok"`; **unchanged and still correct** with the minimal anonymous answer |
| Internal ports | 3000 (app), 2000 (cloudflared metrics, loopback) |
| Migration command / backup / rollback | `deploy/deploy.sh --migrate` (verified backup, `prisma migrate deploy`), `deploy/backup-*.sh`, `deploy/rollback.sh`, `deploy/check-migration-drift.sh`; identical |
| Cloudflare Tunnel assumptions | tunnel routes to `http://app:3000`; app container not reachable from the host; identical |
| `deploy/verify.sh`, `deploy/ci-smoke.sh` | now send `Authorization: Bearer $CRON_SECRET` to `/api/health` (needed for the detailed report); both are staged **and** carry newer unstaged edits |
| Runtime dependencies | `sanitize-html`/`htmlparser2`, `nodemailer`, `maxmind`/`mmdb-lib` are bundled into the server chunks of a real standalone build (strings from each were found in `.next/server/chunks`), so they do not need to appear in `.next/standalone/node_modules`; `@prisma/*`, `pg`, `next`, `react`, `sharp` do |

### Environment-variable contract

Names read by the code: original 38, updated 40. **New, both optional:** `GEOIP_DB_PATH` (path of the optional IP-geolocation database; default `data/geoip/city.mmdb` under the working directory) and `DISABLE_IN_PROCESS_POLLER` (default: poller stays ON). **No name was removed or renamed**, and no new variable is required to start. Variables the code already required (`DATABASE_URL`, `CRON_SECRET` — compose refuses to start without it —, the card-vault settings, Google/Gmail settings, `WEBSITE_API_KEY`, `LEAD_INGEST_SECRET`, `TRUSTED_PROXY`, …) are unchanged. `.env.example` gained the two names plus comments.

### Differences that could stop the updated CRM from starting or connecting

| Risk | Severity | Detail |
| --- | --- | --- |
| New image started before `prisma migrate deploy` | **High if the procedure is bypassed** | sign-in's raw SQL and inquiry creation need the new column/table; the standard `deploy.sh --migrate` order prevents it |
| GeoIP database file | Low (graceful) | `.dockerignore` excludes `data`, and the file is git-ignored, so the image never contains it. Without the file the sign-in IP is still recorded and the Users page shows "Location unavailable"; to enable locations mount a persistent volume and set `GEOIP_DB_PATH`. `compose.yaml` (identical to the original) mounts nothing for it. |
| Deployment files only in the index | **Condition** | `Dockerfile`, `compose.yaml`, `.github/workflows/ci.yml`, `deploy/*` are staged additions, absent from `HEAD`; a deployment from a commit lacks them until the merge is completed and committed |
| Detailed `/api/health` | Low | external monitors parsing it get only `status` |
| Live VPS configuration | **Unknown** | not accessible. An earlier recorded finding (2026-10-17) is that the live stack — TLS on, an internal network named differently, a `verified_ca` health setting — did not match any pushed branch's compose file. This audit confirms the updated project's compose is *identical to the original's* but cannot confirm either matches the VPS. The intended production environment must not be rebuilt from this compose file; reconcile by diffing the live `docker compose config` against it before using `deploy.sh` |
| Node / package engines | None | Node 24 image; Next 16.4.6, Nodemailer 10 and Zod 4.6 support it |
| Build size | Unmeasured | the local standalone output also contains a copy of `docs/` and `vitest.config.ts` (a file-tracing artefact present in the original's design); not measured for the Docker image |

## 6. Direct database access from the website integration

`Travel Agency Website-updated` contains no Prisma, no `pg`, no `DATABASE_URL`, no schema code (verified by its own structural tests earlier today and by the file comparison: all original database files are absent). Its only path to the data is the CRM's HTTP API. The CRM side adds no database credentials for the website.

## 7. What was and was not verified

| Item | Status |
| --- | --- |
| Schema diff, migration set/order/content, lock file, BOM/NUL scan | **Verified (static)** |
| Migration SQL read in full; additive nature | **Verified (static)** |
| Docker/Compose/CI/deploy file equality, env-name comparison, compose YAML parse | **Verified (static)** |
| Standalone production build and bundling of new runtime libraries | **Verified (local build, no database)** |
| `prisma validate`, `tsc`, `eslint`, full no-database Vitest (4,003 passed, 562 skipped) twice | **Verified** |
| Applying either migration; data effects; indexes and locks in practice | **Unverified — deferred (no PostgreSQL)** |
| `_prisma_migrations` checksums and history of the production database | **Unverified (not read)** |
| Live VPS compose/env/network/volume state, Cloudflare Tunnel rules, image in production | **Unverified (no access)** |
| Docker image build and `docker compose config` | **Not run** (Docker not installed) |

## 8. Prioritised corrections before deployment

| Priority | Correction |
| --- | --- |
| P0 | Obtain a disposable PostgreSQL; apply all 75 migrations from scratch and the two new ones on a copy of production-shaped data; run the database-gated tests. |
| P0 | Complete and commit the merge so the deployment files and the unstaged edits are in a commit; build the image from a clean checkout. |
| P0 | Reconcile the live VPS configuration with `compose.yaml`/`.env` (names, networks, TLS settings) before any `deploy.sh` run; do not replace the live configuration with the local one. |
| P1 | Decide the GeoIP volume (`GEOIP_DB_PATH`) or accept "Location unavailable". |
| P1 | Update external readers of `/api/health`. |
| P2 | Stage or discard the newer unstaged edits to `deploy/ci-smoke.sh` and `deploy/verify.sh` so CI and the index agree. |
| P2 | Optional: normalise the single CRLF line in the new migration; add a BOM negative-control test and an ordering assertion. |

## 9. Decision

**Deployment compatibility: NOT VERIFIED.** What can be established statically points to a compatible, expand-only change: no infrastructure file differs from the original's, no environment variable is required that was not already required, and both migrations are additive. But the migrations have never been applied to any PostgreSQL, the production migration history and the live environment were not examined, the merge and the deployment files are uncommitted, and the database-dependent test suites were skipped. It would become **READY WITH CONDITIONS** once the P0 items above are completed.


---

# Final investigation (2026-11-13, evening) — database verification plan, migrations, GeoIP, release structure, runtime

Added after the first version of this report. Read-only with respect to databases, Git and servers; the new evidence below comes from static analysis, Prisma's offline diff, a local standalone run without a database, and Git inspection. Decisions: **Database compatibility NOT VERIFIED · Runtime compatibility NOT VERIFIED · Deployment compatibility NOT VERIFIED** (reasons in section F).

## A. Is an authorised disposable database available?

No. Re-checked just now: no PostgreSQL service, binaries (`psql`, `pg_ctl`, `initdb`, `postgres`), install folder, process or listener on ports 5432–5440/54329/54330; no `INTEGRATION_DATABASE_URL`/`INTEGRATION_ADMIN_DATABASE_URL` variable; Docker/Podman not installed (`docker`, `podman` absent). PostgreSQL integration testing remains deferred by decision; **no database test was run and nothing was created or installed.** The disposable-database guard is unchanged and inactive without `INTEGRATION_DATABASE_URL`.

## B. Database verification plan (to run only on an explicitly authorised, disposable PostgreSQL)

| Item | Requirement |
| --- | --- |
| Server | PostgreSQL **17.11** (the version pinned in `compose.yaml` and `.github/workflows/ci.yml`); loopback only (`127.0.0.1` or `[::1]`), TLS enabled (self-signed is acceptable — the application's connection code uses TLS unless `DATABASE_SSL_MODE=disable`), `max_connections` ≥ 100 |
| Databases | `compass_test` created with `ENCODING 'UTF8' TEMPLATE template0` (a Windows default encoding broke the airport seed in an earlier session), and the maintenance database `postgres` on the same host and port |
| Role | one local role with `CREATEDB`; no production credentials anywhere |
| Shell variables (set in the test shell only, never in a file) | `INTEGRATION_DATABASE_URL=postgresql://<role>:<pw>@127.0.0.1:<port>/compass_test?sslmode=require`; `DATABASE_URL` = the **same** string; `INTEGRATION_ADMIN_DATABASE_URL=…/postgres?sslmode=require` (same host and port) only for the migration-recovery test; `INTEGRATION_SSL=1`; `NODE_TLS_REJECT_UNAUTHORIZED=0` for a self-signed local certificate only |
| How production is excluded | (1) the guard rejects any URL that is not a loopback literal with database exactly `compass_test` (62 regression tests), and its global setup aborts the whole run before any file loads if the URL or the live server answer is wrong; (2) the updated project has **no `.env` file** — `prisma.config.ts` imports `dotenv/config`, which would silently read one, so **before any Prisma CLI command confirm that `.env` does not exist** and that `DATABASE_URL` in the shell is the verified disposable URL (the Prisma CLI is not covered by the Vitest guard); (3) the original CRM's `.env` (remote database) is never copied or read; (4) only the process environment is used |
| Precheck | `npx tsx -e "import('./src/test/disposable-database').then(m => console.log(m.resolveDisposableDatabase()?.database))"` must print `compass_test`; then `npx vitest run src/test` must pass (62) |
| 1. Migrations from scratch | `npx prisma migrate deploy` → **expected:** all 75 migrations applied in order, exit 0; `npx prisma migrate status` → "Database schema is up to date" |
| 2. Drift check | `bash deploy/check-migration-drift.sh` → **expected:** "Migrations and schema.prisma agree (apart from the documented PaymentChargeStatus leftover)" |
| 3. Staged-upgrade simulation | apply the 73 original migrations only (temporarily point at a directory containing them, or apply then compare), insert representative rows (company, accounts, contact inquiries, leads), apply the two new migrations, then verify: row counts unchanged, new `Account` columns NULL, `InquirySubmissionInfo` empty, deleting a `ContactInquiry` cascades its row |
| 4. Full suite | `npx vitest run --no-file-parallelism` (as CI does) → **expected:** 0 failed; the 562 currently skipped tests now execute (25 integration files + `reference-data.test.ts`); any count drift must be explained |
| 5. Targeted expectations | `public-inquiry-idempotency.integration` (8 tests): one row per key, duplicate → same id, simultaneous identical → one row, simultaneous same-key/different-content → one stored and the rest 409 with no 500 and no deadlock, other company/other inbox never collide; `session-lifecycle.integration`: sign-in writes the location columns; `lead-queue`/`public-inquiry-duplicate`/`lead-capture`: advisory-lock and duplicate behaviour; `booking-*`, `airline-*`, `lead-attachments`, `system-health`: existing behaviour on the new schema |
| 6. Website contract | the six `tests/crm-contract-live.spec.ts` tests (website repository) against a CRM instance started on the disposable database with a throw-away `WEBSITE_API_KEY` (`CRM_CONTRACT_URL=http://127.0.0.1:<port>`, `CRM_CONTRACT_KEY=<that key>`) |
| Cleanup | stop the CRM instance; `DROP DATABASE compass_test` only after confirming `select current_database(), inet_server_addr()` shows the disposable server; stop the PostgreSQL service; delete its data directory and certificates; unset the shell variables; confirm `git status` shows no new tracked change |
| Reporting | passed / failed / skipped / blocked listed separately; nothing skipped is reported as passed; mocked results are never counted as PostgreSQL evidence |

**A caution found while preparing this plan (decision required, see the blockers report B-12):** the guard's live check refuses a server whose `inet_server_addr()` is not loopback. For a PostgreSQL running in a Docker container with a published port — which is exactly what the repository's CI does — PostgreSQL reports the container's bridge address, so the guard would refuse that legitimate disposable database. This is a prediction from PostgreSQL semantics and has not been run. A native loopback PostgreSQL (for example the one installed by you) is not affected.

## C. Migration compatibility (re-verified)

* **Files:** current bytes of `20261113000100_inquiry_submission_info/migration.sql` start `-- I` (no BOM); neither new migration has a BOM, NUL or UTF-16 mark; migration folders 73 → 75, new ones sort last; `migration_lock.toml` identical.
* **SQL, by static inspection and by Prisma's offline diff.** `prisma migrate diff --from-schema <original schema.prisma> --to-schema <updated schema.prisma> --script` (no database connection) printed exactly: `ALTER TABLE "Account" ADD COLUMN "lastSignInLocationAt" TIMESTAMP(3), ADD COLUMN "lastSignInLocationSource" TEXT;`, `CREATE TABLE "InquirySubmissionInfo" (…)`, `CREATE UNIQUE INDEX "InquirySubmissionInfo_inquiryId_key" …`, `ALTER TABLE "InquirySubmissionInfo" ADD CONSTRAINT "InquirySubmissionInfo_inquiryId_fkey" FOREIGN KEY … ON DELETE CASCADE ON UPDATE CASCADE`. The two migration files contain these statements and nothing else. Object names follow Prisma's conventions, so no drift is expected. This is static evidence; it does not replace running them.
* **Columns/tables/indexes/constraints/defaults/nullability:** two nullable columns (no default, no rewrite); one table with a text primary key, a unique index on `inquiryId`, `capturedAt` default `CURRENT_TIMESTAMP`, all other columns nullable; one cascading foreign key to `ContactInquiry(id)`. Existing rows are untouched; nothing is tightened or dropped.
* **Existing data:** compatible — new columns read NULL; the new table starts empty.
* **Backward compatibility:** the previous application image runs unchanged on the migrated schema (it selects explicit column lists and never references the new objects).
* **Forward compatibility during a staged deployment — the hazard.** The **new** image on an **un-migrated** database fails: `establishSession` runs a raw `UPDATE "Account" … "lastSignInLocationSource" …` on every sign-in (no fallback), the Users page selects the new columns, and a public inquiry carrying IP data inserts the nested `submissionInfo` (the whole insert fails and the visitor sees the generic error). Already-signed-in sessions are not affected (the new columns are in the Prisma client's global `omit`, so ordinary reads do not select them). Therefore the order **migrate first, then start the new image** is mandatory. `deploy/deploy.sh` enforces it (pending migrations stop the deploy unless `--migrate` is given; with `--migrate` it takes a verified backup, runs only `prisma migrate deploy`, then starts the new containers).
* **Rollback:** application rollback after the migrations is safe (expand-only). Schema rollback is not provided; if ever required it would be a forward corrective migration (drop the unused table/columns) after confirming nothing needs the data. Restoring the pre-migration backup is the data-recovery path.
* **Backup, maintenance window, coordinated release?** *Backup:* yes — `deploy.sh --migrate` takes and verifies one automatically; keep it. *Maintenance window:* not required by the schema (nullable column additions are metadata-only on PostgreSQL 11+; the table is empty; the foreign key takes a very short lock on `ContactInquiry`); what must not happen is starting the new image before the migrations finish, so use the scripted order and expect a brief restart of the app container. *Coordinated CRM + website release:* **no coordination is required**; release the CRM first. The old live website (direct database writes) is unaffected by the additive schema; the updated website needs the CRM's API configured (`WEBSITE_API_KEY`, `LEAD_INGEST_SECRET`, private network alias, `CRM_COMPANY_ID`) and its contact `submissionId` is optional on the CRM side.

## D. `/api/health` (original vs updated)

| | Original | Updated |
| --- | --- | --- |
| Anonymous | full body: `status`, `checkedAt`, `database{ok, firstQueryMs, secondQueryMs / error category}`, `pool`, `readiness{…card vault, TLS, schema, upload storage, integrations, environment…}` | `{ "status": "ok" \| "down" }` |
| With `Authorization: Bearer $CRON_SECRET` | n/a | full body (constant-time comparison; never when the secret is unset) |
| HTTP | 200 ok / 503 down | 200 ok / 503 down (unchanged) |
| Semantics | one endpoint serves as liveness **and** readiness: it runs two `SELECT 1` and a migration-status read, memoised for 2 s; a database outage makes it 503 | unchanged |
| Docker `HEALTHCHECK` | `scripts/healthcheck.mjs` accepts HTTP 200 with `status: "ok"` | identical script; still correct |

Verified locally on a production standalone build with an unreachable database (not Docker): anonymous → 503 `{"status":"down"}`; wrong secret → the same minimal body; correct secret → the detailed body; `scripts/healthcheck.mjs` exits 1 ("unhealthy: HTTP 503"). In-repository readers: `deploy/verify.sh` and `deploy/ci-smoke.sh` now send the secret from inside the container (where `CRON_SECRET` is a required compose variable); `deploy/verify.sh`'s public check (`GET /api/health` → 200) still works. **No monitoring configuration is in the repository, and no document defines an external monitoring contract**; the deployment guides describe the old public report (stale; see below). Therefore external readers are **Unverified (needs VPS/Cloudflare inspection)**, not "none". A backward-compatible *and* non-leaking option exists only for the coarse part: HTTP status and `status` are already preserved; adding `checkedAt` and `database: { ok }` to the anonymous body would reveal nothing beyond up/down, but nothing demonstrates a consumer needs it, and the readiness categories (vault, TLS, schema, integrations) must stay authenticated. Documentation: `docs/SECURITY_POSTURE.md` was corrected; `docs/DEPLOYMENT.md` (≈ lines 489, 526, 540) and `docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` (≈ 409, 411, 488, 638) still describe a public detailed report and are staged files, so they were left for your decision.

## E. GeoIP file and production runtime

* **File:** any MaxMind-format City `.mmdb`; recommended default DB-IP "IP to City Lite" (≈121 MB, CC BY 4.0 — credit DB-IP.com, shown automatically on the Users page; GeoLite2 adds a no-redistribution EULA).
* **Location logic:** `GEOIP_DB_PATH` if set, else `data/geoip/city.mmdb` under the working directory (`/app/data/geoip/city.mmdb` in the image).
* **Optional / graceful:** absent, unreadable or invalid → lookup returns "unresolved"; sign-in still records the IP; the Users page shows "Location unavailable"; a stale file (> 90 days) still works and is flagged once. The file is re-checked at most once a minute, so replacing it needs no restart.
* **Intentionally excluded:** `.gitignore` (`/data/geoip/`, `*.mmdb`) and `.dockerignore` (`data`) — licensed third-party data is never committed or baked into the image.
* **Provisioning that exists:** `npm run geoip:download -- --accept-cc-by-4.0` (official host, validate, atomic rename, keeps `city.mmdb.previous`), `geoip:install -- <file>`, `geoip:verify`; no automatic schedule is enabled by design.
* **Does the VPS already have it?** Unknown — **needs VPS inspection**. `compose.yaml` mounts nothing for it, so inside the current containers the file is absent.
* **Safest compatible delivery (needs your approval; nothing was changed):** a host directory (for example `/srv/compass-tools/geoip`) mounted **read-only** into the `app` service at a fixed path, `GEOIP_DB_PATH` set in the live `.env`, and the file placed by running the existing install tool from the `tools` image (read-write mount for that one command). Not recommended: inside the uploads mount (it is backed up and has its own layout), or baked into the image (licence, size, rebuilds).

## F. Release structure required by the deployment scripts

Why `deploy/deploy.sh` insists on a clean checkout and `origin/main`: it is built so that **only reviewed, merged commits can reach production and nothing on the server is ever overwritten**. It (1) stops if tracked files are modified (`git status --porcelain --untracked-files=no` must be empty); (2) fetches `origin`; (3) refuses a target that is not an ancestor of `origin/main`; (4) checks out `main` and runs `git merge --ff-only origin/main` (never a merge commit or reset on the server); (5) names images by the commit id so the previous version remains for `deploy/rollback.sh`; (6) stops on pending migrations unless `--migrate`, which first takes a verified backup.

Current repository facts (verified from Git): `origin` = `https://github.com/jasurkhonazizkhonov-source/Compass-Tools.git`, **push URL `DISABLED-NO-PUSH`**; `main` = `origin/main` = `HEAD` = `5a77976` and **contains no Dockerfile, compose file or `deploy/*` scripts**; those files exist on the feature branches (`feature/website-api-idempotency-fingerprint` = `MERGE_HEAD c6b8d8e`, `feature/local-upload-storage`, `feature/website-lead-api`) and, here, as staged additions; `MERGE_HEAD` is 15 commits ahead of `main`. Required structure before any deployment: finish and commit the merge on a branch; push it; review/merge it into `main` (so `origin/main` contains the deploy tooling and the work); the VPS checkout must be clean and its `main` an ancestor of the new `origin/main`; then `deploy.sh --ref <sha> --migrate`. The VPS's present checkout is unknown (**VPS inspection**).

## G. Deployment-script and infrastructure review (current differences)

Only two deploy files differ from the original, both in the same way: `deploy/verify.sh` and `deploy/ci-smoke.sh` send the cron secret to `/api/health`. `Dockerfile`, `compose.yaml`, `.dockerignore`, the CI workflow, health check, startup commands, networks, aliases, volumes, backup and rollback scripts are identical to the original's. Environment-variable names: original 38, updated 40; the two additions are optional (`GEOIP_DB_PATH`, `DISABLE_IN_PROCESS_POLLER`); none removed. The staged `AM` state of the two script files means newer edits exist only in the work tree. Nothing was run, and the live layout was not (and cannot be) inspected from this machine.

## H. Runtime evidence (no Docker)

* **Docker:** still not installed (neither `docker` nor `podman` resolves); **no image was built, no Compose stack was started, no Docker runtime claim is made.**
* **Standalone production server, run locally on a spare port (3299) with an unreachable database URL and a throw-away secret, then stopped:** starts with `node server.js`; answers `/api/health` as described in D; `scripts/healthcheck.mjs` reports unhealthy (exit 1) while the database is down. This approximates the container's `node server.js` + health probe but is not a container.
* **Bundling:** `sanitize-html`, `htmlparser2`, `nodemailer` and the MaxMind reader are compiled into the server chunks (their markers were found), so their absence from `.next/standalone/node_modules` is expected; `@prisma/*`, `pg`, `next`, `react`, `sharp` are present.
* **Port 3001 dev server:** process started 06:54 local, still running, still HTTP 500 on every request (including static pages). Its log shows `getOrCreateGlobalAsyncLocalStorage is not a function` and `ensureInstrumentationRegisteredWithDeferredSpans is not a function` from its first request (28 minutes after start, before any build of mine) — the signature of Next.js files replaced on disk (16.3.8 → 16.4.6) beneath a live dev process. It was not stopped, restarted or modified. Separation of concerns: **source correctness** (type-check, lint) PASS; **unit-test correctness** PASS (4,003 passed; 562 skipped); **production-build correctness** PASS; **dev-server process state** broken (needs an owner restart); **Docker runtime** NOT VERIFIED; **actual production readiness** NOT VERIFIED.

## I. Decisions (database, runtime, deployment)

* **Database compatibility: NOT VERIFIED.** The change is additive and reproduced exactly by Prisma's offline diff, but no SQL has run on PostgreSQL and the production migration history was not read.
* **Runtime compatibility: NOT VERIFIED.** The standalone server behaves correctly without Docker; the container image has never been built here.
* **Deployment compatibility: NOT VERIFIED.** Infrastructure files equal the original's and the procedure is safe in principle (backup, forward-only migrations, ordered start, image rollback), but the live VPS state, the missing deploy tooling on `main`, the unfinished merge and the disabled push remote must all be resolved first.
