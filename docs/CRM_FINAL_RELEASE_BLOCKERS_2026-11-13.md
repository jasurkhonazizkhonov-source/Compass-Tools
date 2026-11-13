# Compass-Tools CRM — final release blockers (2026-11-13)

Status of this document: **for review. No commit, push, deployment, database operation or production access was made.** It lists every open item found by the investigation, classifies it, says what can be fixed locally and what cannot, and proposes a release sequence. Evidence is in `FINAL_PRODUCTION_READINESS_AUDIT_2026-11-13.md`, `CRM_DATABASE_AND_DEPLOYMENT_COMPATIBILITY_AUDIT.md` and `CRM_FEATURE_AND_API_COMPATIBILITY_AUDIT.md` (each has a dated "final investigation" section at its end).

Classification used: **Resolved and verified** · **Resolved but not fully verified** · **Requires database verification** · **Requires VPS inspection** · **Requires legal/security review** · **Requires user approval** · **Confirmed blocker** · **Not a blocker** (with evidence).

## 1. Readiness decisions

| Question | Decision |
| --- | --- |
| Structural parity | **READY WITH CONDITIONS** — every route, source file and export, the migration history, the proxy/permission structure and every infrastructure file are preserved; the condition is that the merge is still unfinished and part of the structure (deployment files) is only in the index. |
| Functional compatibility | **READY WITH CONDITIONS** — no confirmed regression; conditions are the unverified database behaviour and the unknown external `/api/health` readers. |
| Database compatibility | **NOT VERIFIED** — both migrations are additive and Prisma's own offline diff reproduces them statement for statement, but nothing has run on PostgreSQL. |
| Runtime compatibility (container) | **NOT VERIFIED** — a production standalone build starts with `node server.js` locally and answers correctly; Docker is not installed, so no container was built or run. |
| Deployment compatibility | **NOT VERIFIED** — infrastructure files equal the original's, but the live VPS cannot be inspected, the repository's deploy tooling is not yet on `main`, and the live compose is documented as differing from every branch. |
| GitHub release readiness | **READY WITH CONDITIONS — for pushing a review branch so that the repository's CI (real PostgreSQL 17 + Docker) can verify it. NOT READY to merge to `main` or deploy.** Source checks pass and a secret scan found nothing; conditions: finish and commit the merge, enable a push remote, decide the guard/CI question (B-12). |

## 2. Blockers and open items

### 2.1 Confirmed blockers

| # | Item | Class | Detail | Fix locally? |
| --- | --- | --- | --- | --- |
| B-1 | Unfinished merge; 74 files with unstaged edits on top of the staged index; 68 untracked paths | **Confirmed blocker** (release process) | `MERGE_HEAD c6b8d8e` (`feature/website-api-idempotency-fingerprint`, 15 commits not on `main`); index and work tree have never been committed. `main`, `origin/main` and `HEAD` are all `5a77976` and contain **no** Dockerfile, compose file or `deploy/*` scripts (they exist on the feature branches and, here, as staged additions). | No — needs your decision to complete and commit the merge. |
| B-2 | No usable push remote | **Confirmed blocker** · Requires user approval | `origin` fetches from `https://github.com/jasurkhonazizkhonov-source/Compass-Tools.git` but its push URL is `DISABLED-NO-PUSH`; remote-tracking branches named `github/*` exist but there is no `github` remote. | No — needs your decision. |
| B-3 | `deploy/deploy.sh` can only deploy what is already on `origin/main`, from a clean checkout, by fast-forward | **Confirmed blocker** (sequence) · Requires VPS inspection | The script stops if tracked files are modified, requires the target to be an ancestor of `origin/main`, runs `git merge --ff-only origin/main`, and tags images with the commit id. Therefore the work must be committed, pushed, merged into `main`, and the VPS `main` must be an ancestor of the new `origin/main` (no local divergence on the VPS). | No — see release sequence. |

### 2.2 Require database verification (deferred by decision; nothing here is claimed as passed)

| # | Item | Status |
| --- | --- | --- |
| D-1 | Applying both migrations (`20261108000100`, `20261113000100`) from scratch and on production-shaped data | **Requires database verification.** Static evidence only (see D-S below). |
| D-2 | Contact-inquiry idempotency: first insert, duplicate, same key with different content (409), simultaneous requests, advisory-lock behaviour, no deadlock, one notification | **Requires database verification** (8 integration tests exist in `public-inquiry-idempotency.integration.test.ts` and are skipped here). |
| D-3 | Sign-in raw `UPDATE` with the two new columns; Users-page select | **Requires database verification.** |
| D-4 | Inquiry-submission persistence (nested insert, `ON DELETE CASCADE`), IP/geo storage | **Requires database verification.** |
| D-5 | The 562 skipped database-gated tests (25 integration files + `reference-data.test.ts`) | **Requires database verification.** |
| D-S | Static equivalence of the migrations with the schema change | **Resolved but not fully verified**: `prisma migrate diff --from-schema <original schema> --to-schema <updated schema> --script` (offline, no connection) outputs exactly the statements in the two migration files — the two `ADD COLUMN`s, `CREATE TABLE "InquirySubmissionInfo"`, its unique index and the cascading foreign key; nothing else. |
| D-6 | Migration ordering hazard: **the new application on an un-migrated database fails every sign-in** (`establishSession` writes `lastSignInLocationSource/At`), the Users page and any new public inquiry that has IP data (nested `submissionInfo`) | **Not a blocker if `deploy.sh --migrate` is used** (it migrates before starting the new image and stops on pending migrations otherwise). Must be preserved by the release procedure. Old code on the new schema is safe (nullable columns, unused table). |

### 2.3 Require VPS inspection (read-only, by you or an authorised session)

| # | Item | Why |
| --- | --- | --- |
| V-1 | What the live stack really is: `docker compose config`, container/network/volume names, `.env` variable **names**, image tags, TLS mode of the database connection | The live stack was previously recorded as differing from every pushed branch. `deploy.sh` brings the stack up from the repository's `compose.yaml`; running it against a different live layout would change infrastructure. |
| V-2 | The commit checked out on the VPS, its cleanliness, and whether it is an ancestor of the commit to deploy | `deploy.sh` precondition. |
| V-3 | `prisma migrate status` against the production database, read-only | confirms the 73 original migrations are the applied history and the two new ones are the only pending ones |
| V-4 | Whether a GeoIP file already exists on the host | decides B-GEO below |
| V-5 | External readers of `/api/health` (uptime monitor, Cloudflare health check/WAF rules, dashboards) | B-HEALTH below |
| V-6 | Backup state (a verified dump exists and restores) | `deploy.sh --migrate` takes one itself; confirm space and encryption settings |

### 2.4 Require user approval

| # | Item | Proposal |
| --- | --- | --- |
| A-1 | Complete the merge and commit | owner action; checks to run afterwards are in section 4 |
| A-2 | Enable a push remote and push a **review branch** (not `main`) so the repository's CI can run the database and Docker jobs | the CI workflow already defines a throw-away PostgreSQL 17.11 with TLS, `prisma migrate deploy` from scratch, a migration-drift check, the full serial test suite with `INTEGRATION_DATABASE_URL`, and a Docker build + Compose smoke test |
| A-3 | **Guard vs Docker-hosted PostgreSQL (B-12 below)** | decide before the first CI run |
| A-4 | GeoIP delivery (B-GEO) | a read-only bind mount added to the `app` service plus `GEOIP_DB_PATH` — a compose and `.env` change on the VPS |
| A-5 | `/api/health` compatibility (B-HEALTH) | accept the minimal anonymous answer, or approve a purely additive `checkedAt` + `database.ok` subset |
| A-6 | Optional hardening of two exported server actions (B-LQ) | move `distributeNewWebsiteLead`/`distributePendingWebsiteLeads` out of the `"use server"` module (three importing source files — `api/cron/leads/route.ts`, `actions/leads.ts`, `lead-intake.ts` — plus `lead-queue.ts` itself, and 13 test files that import or mock them) |
| A-7 | Restart the stale `next dev` on port 3001 | owner of that process |
| A-8 | Edit the staged docs that still describe a public detailed `/api/health` (`docs/DEPLOYMENT.md` lines ≈489/526/540, `docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` ≈409/411/488/638) | they are part of the staged merge, so they were not edited; `docs/SECURITY_POSTURE.md` (not staged) was corrected |

### 2.5 Requires legal/security review

| # | Item |
| --- | --- |
| L-1 | The CRM now stores the visitor IP and approximate location for both public inquiry inboxes (and bookings/leads as before). Retention is "as long as the inquiry"; there is no purge job. The public websites' privacy wording must say so (the updated website's policy mentions the IP only for flight requests). |
| L-2 | The Lead IP Reveal grant model (Admin, or Manager/Ticketing with an explicit grant) differs from "Administrators only" — a policy decision, unchanged from the original. |
| L-3 | GeoIP data licence: DB-IP Lite is CC BY 4.0 (credit shown on the Users page automatically); MaxMind GeoLite2 would add EULA conditions (no redistribution, update obligations). The file must not be committed or baked into the image. |

### 2.6 Resolved and verified

| # | Item | Evidence |
| --- | --- | --- |
| R-1 | Test worker cap | `vitest.config.ts` evaluated with `VITEST_MAX_WORKERS` unset/empty/`0`/`-3`/`abc` → 4; `2`/`8`/`16` → 2/8/16; `globalSetup`, `testTimeout` 45 s and `hookTimeout` 60 s intact; CI runs `--no-file-parallelism`; two full runs earlier today: 4,003 passed / 562 skipped both times. |
| R-2 | No test coverage was removed | all 287 original test files exist in the updated project (3 are NUL-corrupted in the original and could not be counted); in the 284 comparable files `it/test` count went 3,758 → 3,810 and `expect()` calls 8,920 → 9,084; no file has fewer of either; no file gained a skip marker. Skipped database tests stay visible in every run summary (562). |
| R-3 | Campaign HTML sanitiser keeps legitimate content | 16 new fixture tests (editor output, a 600 px newsletter template with nested tables and inline CSS, a call-to-action button, Word/Outlook pasted markup, a hostile mix): all visible text survives; structure, colours, fonts, spacing, borders, radius and sizing survive; script, style blocks, forms, iframes, SVG, handlers, `javascript:`/`data:` links, CSS `url()`/`expression()`/`@import` and `position` are removed; idempotent. **No correction was needed and none was made.** Documented limits: `<font>` loses its colour/face/size (text stays), `float`/flex/shadow are dropped. The preview renders the server-cleaned copy in an iframe with `sandbox=""`. |
| R-4 | Request-size limits are compatible | 5 new tests: the largest genuine contact message (5,000 three-byte characters, every other field at its maximum) is under a third of the 64 KB cap; even 5,000 characters needing six-byte JSON escapes stays under it; the largest genuine flight request is under the website API's unchanged 32 KB cap; a full-length unsubscribe comment (1,000 characters of 3-byte text) is under half of the 32 KB cap in urlencoded and multipart form. Enforcement happens before parsing, by declared length and by counting the stream; oversize → HTTP 413 `{ ok:false, error }` (unsubscribe: its existing "link incomplete" page). The website treats a 413 as "unavailable" (friendly error, no false success, no retry for contact). |
| R-5 | Secrets | secret scan over all 991 tracked and untracked, non-ignored text files: no private key, cloud/API token, tunnel token or real database URL; the 9 pattern hits are test fixtures with throw-away values; no `.env` file in the tree. |
| R-6 | Source health | `tsc`, `eslint .`, `prisma validate` clean; full no-database suite passes; production standalone build passes; standalone `node server.js` serves `/api/health` as designed (below). |

### 2.7 Not a blocker (with evidence)

| # | Item | Evidence |
| --- | --- | --- |
| B-HEALTH | `/api/health` anonymous answer reduced to `{status}` | HTTP codes (200/503) and `status: ok/down` are unchanged, so every probe that checks the status code or the `status` field keeps working; the container `HEALTHCHECK` (`scripts/healthcheck.mjs`) reads only `status` and was run against a local standalone server: 503 `{"status":"down"}` anonymously and with a wrong secret, the full report only with the cron secret, `healthcheck.mjs` exit 1 when the database is down. In-repo readers (`deploy/verify.sh`, `deploy/ci-smoke.sh`) send the secret. **External consumers are unknown → remains Unverified (V-5)**; no monitoring configuration exists in the repository. A safe additive compatibility subset (`checkedAt`, `database.ok`) is possible but not needed without evidence (A-5). |
| B-GEO | GeoIP file absent in the container | optional by design: `.dockerignore` excludes `data`, the file is git-ignored, the app resolves `GEOIP_DB_PATH` else `data/geoip/city.mmdb`, and a missing/invalid file yields "Location unavailable" while the IP is still recorded (covered by tests). Recommended delivery (needs A-4/V-4): a host directory mounted **read-only** into `app`, `GEOIP_DB_PATH` pointing into it, filled by the existing validate-then-rename tool (`npm run geoip:download -- --accept-cc-by-4.0` or `geoip:install -- <file>`) run from the `tools` image; refresh monthly by an operations decision. Not placed inside the uploads mount (backups, layout). |
| B-LQ | `distributeNewWebsiteLead` / `distributePendingWebsiteLeads` exported from a `"use server"` file without an actor check | reachable only through a signed-in session with Leads access (the Server Action manifest lists only the pages `/leads` and `/leads/[id]` as pages from which they can be invoked — the other hosts are API routes; unauthenticated and forged-cookie action POSTs were redirected to `/login` earlier); inputs: a lead id (read: 3 fields; answer: an enum such as `already_assigned`/`not_a_website_lead`); effect: for an eligible lead (website source, unassigned, never distributed) the same offer the system makes automatically, per the lead's own company queue; no data disclosure beyond an enum, no privilege change; unchanged from the original; legitimate callers are all server-side (`lead-intake.ts`, `actions/leads.ts`, `api/cron/leads`). Low severity; the correct fix (moving the functions and their helpers to a non-action module, as was done for the two sweeps) is not minimal, so it was **not** made (A-6). |
| B-COMPAT | Campaign sanitiser, body limits, dependency upgrades | see R-3, R-4 and the feature report |
| B-DEV | Port-3001 dev server returns HTTP 500 | the process (started 06:54) loaded the old Next.js modules; its own log shows module-mismatch errors beginning at its first request after the dependency upgrade; source, type-check, build and unit tests are unaffected. Needs an owner restart (A-7), not a code change. |

### 2.8 Newly found risks (not previously reported)

| # | Item | Class | Detail |
| --- | --- | --- | --- |
| B-12 | **The disposable-database guard's live check may refuse a legitimate Docker-hosted test database (and therefore the repository's own CI)** | **Requires user approval** (the guard must not be changed without it); predicted from PostgreSQL semantics, **not yet run** | `integration-database-guard.ts` asks the server `inet_server_addr()` and refuses unless it is a loopback address (or a local socket). PostgreSQL returns the address the server *accepted* the connection on; for a container published with `-p 127.0.0.1:5432:5432` (exactly what `.github/workflows/ci.yml` does) that is the container's bridge address (typically `172.17.0.x`), not `127.0.0.1`. The first CI run would then abort the whole test job with "non-loopback address". The URL checks (loopback literal, `compass_test`, `sslmode`) are unaffected. Options for the decision: (a) leave the guard and run CI-like tests against a native loopback PostgreSQL only; (b) additionally accept private/bridge ranges (`172.16.0.0/12`, `192.168.0.0/16`, `10.0.0.0/8`) in the live check — a deliberate loosening that an SSH tunnel into a private network would also pass; (c) make the live address check opt-out by an explicit variable set only in CI. Recommendation: decide before pushing; (c) keeps the default strict. |
| B-13 | The detailed-health sentence in the staged deployment documents is stale | Requires user approval | A-8 |

## 3. What can be fixed locally, what cannot

| Category | Items |
| --- | --- |
| **Fixed in this task** | docs/SECURITY_POSTURE.md health wording (unstaged file); two additive test files (sanitiser fixtures, size headroom). No source behaviour was changed. |
| **Can be fixed locally later, no database, outside the staged set** | optional BOM negative-control and migration-ordering assertions (new tests); the `lead-queue` hardening (A-6, after approval); `<font>` allowance in the sanitiser (not recommended: no evidence of need) |
| **Need an authorised disposable PostgreSQL** (local install by you, or the repository's CI after a push) | D-1 … D-5, the guard against a real server, the six website contract tests, database-backed browser flows |
| **Need read-only VPS inspection** | V-1 … V-6 |
| **Need explicit approval** | A-1 … A-8, B-1, B-2, B-12 |
| **Need legal/security review** | L-1 … L-3 |

## 4. Proposed release sequence (nothing below has been done)

1. **Decide and complete the merge** (A-1). Then, on the committed tree, re-run `tsc`, `eslint .`, `prisma validate`, `npx vitest run`, the standalone build, and the secret scan; confirm `git status` is clean and the deployment files are in the commit.
2. **Decide B-12** (guard vs Docker) and A-3/A-5/A-6/A-8 so the first CI run is meaningful.
3. **Enable a push remote** (B-2) and push a **review branch**, not `main`. Open a pull request. The CI jobs then provide the evidence this environment cannot: PostgreSQL 17.11 with TLS, all 75 migrations from scratch, the drift check, the full database-backed suite (562 tests that are skipped here), and the Docker build with a Compose smoke test (the first real container verification). Treat any red job as a blocker and fix it before continuing.
4. **Read-only VPS inspection** (V-1 … V-6); reconcile the repository's `compose.yaml`/`.env.example` with the live stack **on paper first**; do not let `deploy.sh` bring up a compose file that differs from the live layout.
5. **Merge the PR into `main`** so that `origin/main` contains the deploy tooling and the VPS `main` is an ancestor (fast-forward only).
6. **Provision GeoIP** (A-4) if locations are wanted; set `GEOIP_DB_PATH`.
7. **Deploy** from the VPS with `bash deploy/deploy.sh --ref <sha> --migrate` in an agreed window (the script shows the change set, takes a verified backup, applies only `prisma migrate deploy`, then starts the new image), then `bash deploy/verify.sh` (it sends the cron secret to `/api/health`). No maintenance window is required by the schema (both migrations are metadata-only on current PostgreSQL), but sign-in must not be attempted before the migrations are applied.
8. **Release the website after the CRM is healthy** (`WEBSITE_API_KEY`, `LEAD_INGEST_SECRET`, `CRM_API_URL` over the private network alias, `CRM_COMPANY_ID`); the CRM does not depend on the website release; the old live website (direct database writes) keeps working throughout because the schema change is additive.
9. **Rollback:** previous image through `deploy/rollback.sh` is safe at any point after the migrations (expand-only schema); a schema rollback is not provided and not needed; restore from the pre-migration backup only if data is damaged.
10. Afterwards: restart the stale port-3001 dev server, update the three stale health-contract documents, and schedule the dependency-tooling advisories.
