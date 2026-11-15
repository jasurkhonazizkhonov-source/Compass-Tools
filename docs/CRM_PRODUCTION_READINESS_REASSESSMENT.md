# CRM Production Readiness Reassessment

Date: 2026-11-16 (supersedes the 2026-11-15 version; its still-valid findings are carried into section 4). Target: `compass-tools-updated`. Nothing was deployed, and no production system, VPS, scheduled job, environment variable, credential, database or migration was touched. Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. Verdict

| Decision | Status |
| --- | --- |
| Feature implementation (Gmail-aware sequence workflow) | **COMPLETE WITH LIMITATIONS** |
| GitHub | **READY FOR REVIEW-BRANCH PUBLICATION** (existing review branch; never `main`) |
| Production | **NOT READY FOR REDEPLOYMENT** |

**Will automatic sequence sending run in production without manual processing?** By design **yes on the self-hosted Docker/VPS deployment**: the server's own once-a-minute poller sends due steps (task reminders keep running on the same tick), and there is no manual button. **Not proven**: nothing was deployed, Docker was never built here, no PostgreSQL was available, so claim/lock behaviour was exercised only against an in-memory fake. After a deployment, confirm with the detailed health endpoint (`Authorization: Bearer <CRON_SECRET>`) that `readiness.sequenceScheduler` is `running`. Nothing on the VPS needs changing for this.

**Can it send a customer the same email twice?** Not through any path found, **but exactly-once is not claimed**: unknown outcomes are held for a person instead of being resent, and a database-level guarantee needs a migration that was not made (retry audit, section 6).

## 2. Verification results

| Check | Result |
| --- | --- |
| `tsc --noEmit` | PASSED |
| `eslint .` | PASSED (0 errors, 0 warnings) |
| `prisma validate` | PASSED; **no schema change and no migration in this task** (the previous task's `20261115000100` is still unapplied anywhere) |
| Vitest, full suite | **4,431 passed, 0 failed; 1,099 SKIPPED** (database-gated integration suites, 55 files) - skipped tests are not counted as passed |
| Standalone production build | PASSED |
| Standalone server boot, background scheduler, health | PASSED without a database (see below) |
| Docker image build / runtime | **NOT RUN** - Docker is not installed |
| PostgreSQL integration suites, migrations against PostgreSQL | **BLOCKED / SKIPPED** - none installed; the disposable-database guard was not touched |
| Real Gmail / Google OAuth, real browser sign-in | **NOT RUN** |
| Secret scan (1,036 files, tracked + untracked, ignored excluded) | PASSED - only the 11 throwaway test literals reviewed on 2026-11-13; no `.env` |
| Original CRM / original website vs baseline | PASSED - 1,378/1,378 and 1,122/1,122 files identical |
| Ports 3000, 3001, 3100, 3101 | no listener; nothing stopped or restarted (my own smoke-test servers on 3290 were started and stopped by me) |

Standalone server runtime checks (dummy unreachable database, bearer secret local only, port 3290):
- poller on: first sweep ran and **failed safely** (`[sequence-sender] drainDueSequenceSteps failed`), the server stayed up, `/api/health` answered `status: down` with `readiness.sequenceScheduler = "stalled"` - it did **not** claim `running` while the job was failing;
- `DISABLE_IN_PROCESS_POLLER=true`: `readiness.sequenceScheduler = "disabled"` and no background-job activity in 65 s;
- `/api/cron/sequences` without the bearer: 401.

## 3. What changed in this task (Gmail-aware sequence workflow)

Detailed in the four task reports: `CRM_GMAIL_CONNECTION_AND_SEQUENCE_ENROLLMENT_AUDIT.md` (pre-confirmation Gmail check with five distinct outcomes, return to the lead after connecting, company isolation, root cause of the "failed in Sequences but enrolled on the Lead" defect), `CRM_SEQUENCE_RETRY_AND_DUPLICATE_PREVENTION_AUDIT.md` (write-ahead delivery marker, unknown outcomes held, Retry now / It was sent / Send again), `CRM_SEQUENCE_AUTOMATIC_SENDING_VERIFICATION.md` (poller, health, no manual button), `CRM_SEQUENCE_LEAD_STATUS_AND_UI_CONSISTENCY_AUDIT.md` (one status function for both pages).

## 4. Findings carried forward and re-checked

| Finding | Now |
| --- | --- |
| Scheduler for `/api/cron/sequences` | Resolved in code (poller); proof requires a deployment. Vercel would still need an external caller. |
| 1,099 database tests unverified | **Still open.** The new Gmail/delivery behaviour is verified only against mocks. |
| Disposable-database guard | Unchanged; B-12 (Docker-hosted CI database vs loopback requirement) remains an owner decision. |
| New migration `20261115000100_account_contact_detail_edit_permission` (contact phone/email permission) | **Still never run against PostgreSQL**; rehearse on a disposable database before any deploy. Default `true` preserves current abilities (owner decision). |
| Booking-signer IP reveal grant wider than "Administrators only" | Unchanged; owner decision. Lead and inquiry IP reveal are Administrator-only. |
| Privacy Policy gap (IP/location for contact inquiries and sign-ins) | Still open; the website was not touched. |
| Docker build never verified | Still open. |
| Previous improvements (Ctrl+K search, lead/contact/quote search, booking search, phone/email permission and server enforcement, bulk selection and roles, status filter, Commissions/Salesboard text removal and calendar, IPv4/IPv6 and Cloudflare handling, Admin-only IP) | Re-checked by the full suite: the tests for each still pass (e.g. `global-search.test.tsx`, `contact-detail-edit-permission*.test.ts`, `bulk-selection*.test.*`, `range-date-fields.test.tsx`, `request-ip-parsing.test.ts`). Not re-checked in a browser. |

## 5. New risks and decisions from this task

| ID | Item |
| --- | --- |
| N-7 | **No schema change was made**, so the delivery state machine lives in `SequenceStepLog` text markers. A cleaner typed implementation plus a partial unique index on SENT rows is described (not made) in the retry audit and needs approval and a PostgreSQL rehearsal. |
| N-8 | An unconfirmed delivery needs a **person** (they must look at the sender's Gmail Sent folder; the CRM has only the send permission). Until they decide, the lead's sequence is held and that is shown on the lead and the sequence page. |
| N-9 | The Gmail check performs a real token refresh per distinct sending agent (bounded for bulk). A Google outage therefore blocks starting sequences (with a "try again" message) instead of enrolling blindly. |
| N-10 | `readiness.sequenceScheduler` is visible only in the detailed health response; it is not surfaced on the System Health page or in the sequence UI. |
| N-11 | Concurrent identical approvals rely on the PostgreSQL advisory lock (not exercised here). |
| N-12 | A sweep still runs sequentially (one provider round trip per email); there is no per-agent daily send cap. |

## 6. Production deployment requirements (when separately approved)

1. Rehearse all migrations on a disposable PostgreSQL and run the 1,099 skipped integration tests there.
2. Build and smoke-test the Docker image on a Docker host (the CI smoke job).
3. Reconcile the live stack with the branch being deployed, then `deploy/deploy.sh --migrate` (backup first).
4. Leave `DISABLE_IN_PROCESS_POLLER` unset; check `readiness.sequenceScheduler = running` within about two minutes of start.
5. Confirm Google OAuth configuration (`GOOGLE_CLIENT_ID/SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY`, the Gmail callback redirect URI registered in Google Cloud) - without it every Gmail check reports "reconnect".
6. Decide the open owner questions (contact phone/email permission default; booking-IP reveal grant; the optional delivery-guarantee migration N-7) and align the Privacy Policy.

**Not done and not authorized:** deployment, VPS changes, production database access, real customer emails. A separate explicit approval is required.
