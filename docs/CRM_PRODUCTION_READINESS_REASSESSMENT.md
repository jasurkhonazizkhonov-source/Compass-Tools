# CRM Production Readiness Reassessment

Date: 2026-11-15. Target: `compass-tools-updated`. Nothing was deployed, and no production system, VPS, scheduled job, environment variable, credential, database or migration was touched. Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. Verdict

| Decision | Status |
| --- | --- |
| Feature implementation | **COMPLETE WITH LIMITATIONS** |
| GitHub | **READY FOR REVIEW-BRANCH PUBLICATION** (the existing review branch; never `main`) |
| Production | **NOT READY FOR REDEPLOYMENT** |

**Will automatic sequence sending run in production without manual processing?** In design, **yes, on the self-hosted Docker/VPS deployment**: the application's own server process now sends every due sequence step once a minute (the same in-process poller that already runs task notifications; on by default), and the "Process Due Steps" button is gone. It is **not proven**: no deployment was made, the Docker image was never built here, no PostgreSQL was available, and the claim/lock behaviour was exercised only against an in-memory fake. After deploying, confirm with the detailed health endpoint that `readiness.sequenceScheduler` is `running`. Nothing needs to change on the VPS for this (see the scheduler audit for the optional redundant systemd timer, **not applied**).

## 2. Verification results

| Check | Result |
| --- | --- |
| `tsc --noEmit` | PASSED |
| `eslint .` | PASSED (0 errors, 0 warnings) |
| `prisma validate` / `prisma generate` | PASSED |
| Vitest full suite | PASSED: **4,320 passed, 0 failed**; **1,099 SKIPPED** (database-gated integration suites, 55 files) - skipped tests are not counted as passed |
| Database-gated integration suites (`INTEGRATION_DATABASE_URL`) | **SKIPPED** (1,099 tests); not counted as passed |
| Standalone production build | PASSED (compiled successfully; `.next/standalone/server.js` produced) |
| Standalone server boot | PASSED without a database: the built server starts, the poller starts and both sweeps run on the first tick and **fail safely** (`DatabaseNotReachable` logged as `[sequence-sender]` / `[task-notifier]`, no crash); `/api/cron/sequences` answers 401 without the bearer; pages that need the database return 500 (expected) |
| Docker image build / runtime | **NOT RUN** - Docker is not installed on this machine; nothing about the image is claimed |
| Real PostgreSQL migration run | **NOT RUN** - none installed; the new migration was never applied anywhere |
| Browser tests against a running, signed-in CRM | **NOT RUN** - needs a database |
| Secret scan of everything to be committed | PASSED: 1,028 files scanned; only the 11 throwaway test literals reviewed on 2026-11-13; no `.env` file; ignored files stay ignored |

## 3. Re-check of every earlier finding

| Earlier finding | Now |
| --- | --- |
| No confirmed scheduler for `/api/cron/sequences`; steps may never be sent | **Resolved in code**: the poller sends sequences. Needs deployment + the health check to be proven. Vercel would still need an external caller. |
| Database-backed integration tests unverified | **Still open.** 1,099 skipped; the new sequence, permission, search and migration behaviour is verified only against mocks. |
| Disposable-database guard must not be weakened | **Unchanged**; the guard files were not touched. The B-12 question (a Docker-hosted CI database vs the loopback requirement) remains an owner decision. |
| Stale dev server on port 3001 returned 500 | **No longer present**: on 2026-11-15 nothing listened on 3000, 3001, 3100 or 3101 (checked with the process list; nothing was stopped or restarted by this work). |
| Lead IP reveal wider than Administrator | **Fixed**: lead IP reveal is Administrator-only (`canRevealLeadSubmissionIp`); the booking-signer IP reveal still honours an Administrator's explicit `bookings.reveal_ip` grant to a Manager/Ticketing user - flagged below for a decision. The inquiry reveal was already Admin-only. |
| Privacy wording | **Still open.** The website's Privacy Policy describes IP/location for **flight requests** only; the CRM can also store them for contact-form inquiries (when the website sends a signed visitor context - it currently does not) and for staff sign-ins (internal). Align the text before enabling contact-form capture. Not changed (the website must not be modified in this task). |
| Docker build never verified | **Still open.** |
| Merge state / stash | The merge was concluded earlier on the review branch; the one stash (`pre-merge: UI dev-CSP change`) is untouched; no destructive Git operation was run. |
| IP/geo improvements still present and correct | **Verified present** (`net.isIP` validation, canonical IPv6, trusted-proxy gate, Cloudflare approximate location, no coordinates) and covered by passing tests; not rewritten. |

## 3a. IP / location visibility (user decision: Administrators only for full IPs)

| Surface | Who can reveal the full IP |
| --- | --- |
| Staff sign-in IP (Users page) | Administrators (page and query are Admin-only; unchanged, retention rule unchanged) |
| Lead submission IP | **Administrators only** (changed) |
| Inquiry (contact form) IP | Administrators only (unchanged) |
| Booking signer IP / IP-vault history | Administrator, or a Manager/Ticketing user an Administrator has explicitly granted `bookings.reveal_ip` (unchanged; **decision for the owner** - it is an Admin-delegated, audited, step-up-protected grant, but it is not "Administrators only") |

Global search never returns an IP; no log line carries a full IP (existing tests).

## 4. New blockers and risks from this task

| ID | Item | Status |
| --- | --- | --- |
| N-1 | New migration `20261115000100_account_contact_detail_edit_permission` has never run against PostgreSQL. It is a single additive `ADD COLUMN ... NOT NULL DEFAULT true`. | Needs a rehearsal on a disposable database, then `deploy.sh --migrate` (which backs up first). **Not applied.** |
| N-2 | Sequence sending is at-least-once around a crash (send accepted, process dies before the log is written); a unique-constraint fix needs a migration and approval. | Documented (scheduler audit, risk 1). |
| N-3 | A provider call that hangs longer than the 2-minute claim lease could be re-claimed and sent twice. | Mitigated for the poller only (stuck runs no longer block it); no provider timeout was added. |
| N-4 | `readiness.sequenceScheduler` reports per instance; a multi-instance deployment shows the state of whichever instance answers. | Accepted; single app container today. |
| N-5 | Per-user phone/email permission defaults to `true` (preserves today's ability). | Owner decision. |
| N-6 | Booking-IP reveal grant is wider than "Administrators only". | Owner decision (section 3a). |

Carried forward unchanged: live VPS stack does not match any pushed branch (reconcile before `deploy.sh`); `origin` push URL is disabled (pushes use the explicit URL); commit identity is the generic `Compass Tools Deploy`; the website's Privacy Policy gap.

## 5. Production deployment requirements (when separately approved)

1. Rehearse all migrations (including `20261115000100`) on a disposable PostgreSQL; run the 1,099 skipped integration tests there.
2. Build and smoke-test the Docker image on a Docker host (the CI smoke job does this).
3. Reconcile the live stack with the branch being deployed, then `deploy/deploy.sh --migrate` (backup first).
4. Leave `DISABLE_IN_PROCESS_POLLER` unset; after start, read `/api/health` with the cron bearer: `readiness.sequenceScheduler` must be `running`.
5. Optionally install `deploy/systemd/compass-tools-sequences.timer` for redundancy.
6. Decide N-5 / N-6 and align the Privacy Policy before capturing contact-inquiry IPs.

**Not done and not authorized:** deployment, VPS changes, production database access, real customer emails. A separate explicit approval is required.
