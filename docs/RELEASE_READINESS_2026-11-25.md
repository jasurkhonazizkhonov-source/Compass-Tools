# Release readiness - branch `release/compass-tools-2026-11-22`, 2026-11-25

This is the single place that says **what was verified, how, and what was not**. A feature is never called production-ready here because its code compiles. Evidence levels used below:

| Level | Meaning |
|---|---|
| **L1** | implemented and unit-tested (mocked dependencies) |
| **L2** | tested against a real PostgreSQL 17.11 (integration tests, migrations, measured queries) |
| **L3** | tested in a real browser (a Chromium-based browser, production build) |
| **L4** | tested with an actual connected external service (a real Google account / Gmail mailbox / Cloudflare) |
| **L5** | tested on the production VPS |
| **--** | not tested |

**No row below has L5. Only the public Google sign-in script (loaded in the browser) touched an external service; no Gmail mailbox, no Google account and no Cloudflare was used.**

## What is verified

| Area | L1 | L2 | L3 | L4 | L5 | Notes |
|---|---|---|---|---|---|---|
| Contact-only sequence enrollment (enroll, first and follow-up emails, completion, addresses, suppression at enrollment and before sending, duplicates, 10 simultaneous requests, pause/resume, unenroll, retry, reply stops the right enrollment, authorization, company limits, rollback trigger) | yes | yes (23 tests) | yes (Contacts selection: reasons list; sequence table row) | -- | -- | Gmail and the mailbox are scripted fakes in the L2 tests; the L3 run could not succeed in enrolling because the seeded Admin has no Gmail (it correctly said so) |
| Lead-based enrollment, Enroll All Contacts, bulk actions, campaigns | yes | yes | -- | -- | -- | existing suites, updated only for the required `contactId` and the intentionally changed contact messages |
| Migrations `20261125000100/200/300` | -- | yes (backfill of existing rows, drift check, rollback SQL, old-image insert) | -- | -- | -- | not applied to any server other than the local test databases |
| Google One Tap and normal Google sign-in | yes | -- | partly (Google's real script loaded and rendered its button; no signed-in Google account, so the suggestion itself was never displayed) | -- | -- | the suggestion's real display needs your OAuth client and domain (Google Cloud steps in docs/DEPLOYMENT.md) |
| CSP (CRM, card pages, sign-in page, 13 marketing pages) | yes | -- | yes (production build: login, dashboard, leads, contacts, quotes, bookings, subscriptions, system health, users, backup, sequence editor, dialogs, theme, search, all 13 marketing pages) | -- | -- | the standalone server (what the image serves) was run locally and serves the hashed policy; the container itself was not; see docs/CSP.md |
| Rate limits (shared PostgreSQL counters) | yes | yes | -- | -- | -- | public sign-up limit verified live on a local server with `TRUSTED_PROXY=cloudflare` (429 + `Retry-After` after exactly 30) |
| Database Backup: create, download, restore | yes | yes (dump, `pg_restore --list`, restore into a new database, row/index/constraint/sequence comparison, `prisma migrate status`) | yes (real button, file received, headers) | -- | -- | |
| `restore-db.sh` / `backup-db.sh` logic | -- | yes (24 checks, Docker stand-in, real PostgreSQL) | -- | -- | -- | **not a Docker run** |
| Docker build, Compose, `ci-smoke.sh`, CI workflow, replacement-VPS recovery | -- | -- | -- | -- | -- | Docker is not installed on the development machine |
| Reply detection with a real mailbox | yes | yes (scripted mailbox) | -- | -- | -- | procedure ready in the Gmail runbook section 10; **not performed** |
| GeoIP on the VPS, Cloudflare tunnel/WAF/firewall, `TRUSTED_PROXY` in production | -- | -- | -- | -- | -- | no access from the development machine; read-only inspection is the first step when you give access |

## Test results (this branch head)

| Suite | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | clean |
| ESLint | `npm run lint` | clean |
| Prisma | `npx prisma validate` | valid |
| Migration drift | `bash deploy/check-migration-drift.sh` against a freshly migrated PostgreSQL 17.11 | agrees (apart from the documented `PaymentChargeStatus` leftover) |
| Unit and component tests (no database) | `npx vitest run` (4 workers) | **5,919 passed, 672 skipped (database-gated), 1 failed**: `quote-builder-gds-tabs.test.tsx`, a file this work never touched; it passes 8/8 alone, twice, and is the documented CPU-contention flake (see below) |
| PostgreSQL 17.11 integration | `npx vitest run --no-file-parallelism integration` with the disposable `compass_test` database, PG17 client tools set | **703 passed, 1 skipped, 0 failed** (38 files, 10 min) |
| `npm audit --omit=dev` | | 0 vulnerabilities |
| Production build | `npm run build` | succeeds; the post-build step hashes 13 pages |

**The two step-editor failures of the previous report** were reproduced on demand (12 busy processes) and are not an application defect: the two slow tests waited 1 s for a save made of several keystrokes and a React transition, and clicked "Add Step" again while the first save still held it disabled. They now wait for the button and use an explicit wait, and pass under the same load. **The one remaining intermittent failure in a full run is `quote-builder-gds-tabs`**, the same class (a jsdom test missing a default wait on a loaded 8 GB machine; `vitest.config.ts` documents the measurement and the 4-worker cap). It was not changed.

**The 3,000-subscriber campaign test:** its 14 s run is the test's own in-memory stand-in doing quadratic work (it has its own 180 s limit and a comment). Measuring the **real** query found something real: the rolling-24h quota count read every send the sender's campaigns ever made, per recipient (68 ms at 90,000 history rows, growing). Two additive indexes fixed that (18 ms, flat). The test is a correct-behaviour test, not a performance test; a real-PostgreSQL campaign pass of 3,000 recipients was not timed.

## Production configuration checklist (nothing here was changed in production)

1. **`TRUSTED_PROXY=cloudflare`** in the production `.env` (docs/DEPLOYMENT.md section 5). Without it every public rate limit is **inactive** (the client address is never read) and signer IP/location are not recorded. System Health shows a notice to Admins while it is unset.
2. The origin must be reachable **only** through `cloudflared`: `compose.yaml` publishes no application port (the CI smoke test checks this; it has not been run). If the origin were reachable directly, a client could forge `CF-Connecting-IP`. Check on the VPS: `ss -ltnp` shows nothing listening publicly on 3000 or 5432, and the provider firewall allows only SSH.
3. Rate-limit behaviour on failure: the public limiter **fails open** (a database error never blocks a customer form), the per-account limiter fails closed. Counters are rows in PostgreSQL, so every container shares them. Limits (per 15 minutes unless stated): sign-in failures 15 per IP, Gmail connect 12 per account, backup create 6 / download 20 / delete 30, sequence enroll 300, Enroll All batches 1,500, bulk actions 60, recovery 60, staff customer emails 100, public forms 20-30 per IP, website API 120 per minute, quote-opened pixel 600 per IP. None was changed except the two new ones.
4. After deploying: sign in as Admin, open System Health, and confirm the reply-detection panel, the scheduler and (once set) the trusted-proxy notice disappears.
5. Gmail: every account that **owns a contact** or **enrolls** contacts into a sequence now sends from its own Gmail, so those accounts need Gmail connected (and re-connected after the `gmail.metadata` release for reply detection). The enrollment says so, per contact, when it is not.
6. Run the **three migrations** with `bash deploy/deploy.sh --migrate` after a verified backup (docs/DEPLOYMENT.md 2c: the rollback procedure, including what to do about contact-only enrollments before rolling the image back).

## Browsers and screens

Tested: the in-app browser (a Chromium engine) at 1280, 768 and 375 pixels for the sign-in page; ~1100 pixels for the CRM pages above; ~800 and **375 pixels** for the Contacts selection and the Add to sequence dialog (no horizontal overflow, the dialog fits the screen with full-width buttons). **Observed, not changed** (the established UI was kept): at 375 pixels the row checkboxes are 16x16, the dialog buttons 32 px high and its close button 28x28, all below the usual 44-pixel touch target. **Not tested:** Firefox (not installed), Safari/WebKit (not available on Windows), Chrome and Edge as separate products (installed, but not drivable from here without acting inside the user's own signed-in browser), real phones, keyboard-only navigation and screen readers beyond the accessible names read from the page. Constructable stylesheets (theme switch) fall back to a nonce'd `<style>` on older Safari.

## Blockers and the exact action for each

No code defect is known to block deployment. These are **not done**, and each needs you:

1. **Docker build and `bash deploy/ci-smoke.sh` on a machine with Docker, and a CI run** - until then the image, Compose, the container healthcheck and the container's `pg_dump` are unproven (commands in docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md). Also check `curl -I https://<origin>/about` shows hashed `script-src`.
2. **Google Cloud:** authorized JavaScript origin, published consent screen with the real privacy/terms links, `gmail.metadata` scope (restricted; Google verification) - then sign in on the real domain and look for the One Tap suggestion.
3. **A real-mailbox reply test** (Gmail runbook section 10) with a dedicated mailbox and owned test recipients.
4. **`TRUSTED_PROXY=cloudflare`** and the origin/firewall checks above, on the VPS.
5. **GeoIP database installed on the VPS** (docs/GEOIP.md) - not inspected.
6. **Authorize the push**: the push URL of `origin` is `DISABLED-NO-PUSH` by your own safeguard.

## Status

**Ready with documented external configuration requirements - not production-verified.** It must not be deployed before blocker 1 (the Docker smoke run) has passed; blockers 2-5 decide which features are usable on day one (One Tap, reply detection, public rate limits, location).
