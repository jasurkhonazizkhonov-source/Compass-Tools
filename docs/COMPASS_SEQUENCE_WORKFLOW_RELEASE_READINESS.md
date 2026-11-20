# Release Readiness - Sequence Delivery, Failed Sign-ins, Customer Email Privacy, Subscriptions and Queued Campaigns

Date: 2026-11-20 (completion audit). **The CRM as a whole is not declared production-ready.** Statuses: READY LOCALLY / PENDING DB REHEARSAL / PENDING GMAIL VERIFICATION / REQUIRES IMPLEMENTATION / REQUIRES USER DECISION / REQUIRES LEGAL REVIEW / REQUIRES PRODUCTION APPROVAL / BLOCKED.

## 1. Status by area

| Area | Status | Evidence / what is missing |
| --- | --- | --- |
| Gmail readiness states, wrong-company refusal, return-to-lead | READY LOCALLY; PENDING GMAIL VERIFICATION | mocked tests pass; real OAuth/refresh/scope behaviour unverified (runbook section 1) |
| Ambiguous-send handling (hold, never auto-resend, human resolves) - sequences and campaigns | READY LOCALLY; PENDING GMAIL VERIFICATION | Gmail 5xx / timeout / dropped response map to "ambiguous" (`gmail-send.test.ts`); real Gmail not contacted |
| Delivery state model (typed states, guarded transitions) | READY LOCALLY (code-level) | `sequence-delivery-state.ts`; persistence is still text markers |
| Typed persistence + partial unique indexes | REQUIRES USER DECISION; PENDING DB REHEARSAL | proposal only; no migration for it |
| Duplicate-send prevention across workers (sequences) | PENDING DB REHEARSAL | claim, lease-ownership check, in-flight marker and (new) step-conditional post-send writes verified on a fake; not on PostgreSQL |
| Scheduler single instance / shutdown | READY LOCALLY; REQUIRES PRODUCTION APPROVAL | tested; an in-flight sweep now stops taking new work on shutdown |
| Scheduler multiple instances | REQUIRES IMPLEMENTATION / evidence | run one app instance |
| Scheduler visibility in System Health | READY LOCALLY | four states tested; per process; covers the sequence sweep only |
| Recovery-action authorization (sequence AND lead) | READY LOCALLY (fake DB); PENDING DB REHEARSAL | negative tests for a reassigned / hidden lead, other company, other roles |
| Failed sign-in log (Admin only) | READY LOCALLY | page, actions, proxy, capture, flood roll-up, deletion + audit tested; not run in a browser |
| Customer email privacy (masking, reveal, ids instead of addresses, toggle) | READY LOCALLY; PENDING DB REHEARSAL | 100+ tests; the reveal SQL (atomic counter) is **not** verified on PostgreSQL; two leak paths found and fixed in this audit |
| Staff notification emails carrying the complete customer address | REQUIRES USER DECISION | by design today; bypasses the reveal allowance |
| Subscriber import (background, 250,000 rows / 4 MB) | READY LOCALLY; PENDING DB REHEARSAL | in-memory database only |
| Campaign builder | READY LOCALLY | URL / HTML / personalization safety tested; not run in a browser |
| Queued campaign delivery | READY LOCALLY; PENDING DB REHEARSAL; PENDING GMAIL VERIFICATION | 33 worker tests on a fake DB + fake provider |
| Large-campaign capacity (Gmail) | REQUIRES USER DECISION | Gmail cannot send hundreds of thousands; needs an approved bulk provider |
| Marketing consent / retention of failed sign-in data / reveal policy | REQUIRES LEGAL REVIEW | nothing here is a legal conclusion |
| Browser verification of the new screens | BLOCKED | no approved local database (the project `.env` files of the originals point at a remote database and were never used); sign-in needs Google |
| Real PostgreSQL behaviour (582 database-gated tests in the final run) | BLOCKED | skipped, not passed; no approved disposable database |
| Docker image / deployment | REQUIRES PRODUCTION APPROVAL | not built here (CI `ci-smoke.sh` does it) |
| Production deployment / migration | REQUIRES PRODUCTION APPROVAL | not performed |

## 2. Prompt 1 - the 15-item final summary

1. **Branch / HEAD / upstream.** `review/crm-verification-2026-11-13`; HEAD at the start of the completion audit `3640790`; `origin` = `https://github.com/jasurkhonazizkhonov-source/Compass-Tools.git`; the **push URL is configured `DISABLED-NO-PUSH`** in this checkout.
2. **Was the reported commit present?** Yes - local HEAD equalled the reported sequence-workflow commit; the work of both prompts is uncommitted on top of it until the commit recorded in section 6.
3. **Files changed (Prompt 1).** `src/server/due-sequence-steps.ts`, `src/server/background-poller.ts` (new), `src/server/scheduler-status.ts`, `src/server/system/health-checks.ts`, `src/server/actions/sequences.ts`, `src/instrumentation.ts`, `src/lib/sequence-delivery-state.ts` (new); tests `background-poller`, `health-checks-scheduler`, `sequence-delivery-state`, `contact-permission-migration`, `sequences.test.ts`; the four `COMPASS_*` reports.
4. **Improvements made.** Lease-ownership check before the send; lead-level authorization of recovery and unenroll; poller extracted with overlap skipping, stuck-run recovery, SIGTERM/SIGINT; (completion audit) step-conditional post-send writes, in-flight sweep stops on shutdown, category-only error logging.
5. **Proposed-but-unapplied schema.** The typed delivery-state model with partial unique indexes (`COMPASS_SEQUENCE_DELIVERY_AND_CONTACT_PERMISSION_MIGRATION_READINESS.md`): not added, not applied.
6. **Scheduler UI and tests.** System Health row "Automatic sequence sending" (running / disabled / stalled / unknown), tested; failure and recovery covered in `instrumentation-poller.test.ts`.
7. **Gmail findings.** All behaviours verified with mocks only; real Gmail not contacted.
8. **Authorization findings.** Recovery and unenroll previously checked the sequence only (fixed); the rest verified; new negative tests.
9. **Contact-permission migration** (`20261115000100`, `Account.canEditContactDetails` default true): additive; assessed from source; never executed.
10. **Tests.** See section 3 for exact commands and numbers; database-gated files skipped.
11. **Build.** See section 3.
12. **Unresolved defects / limits.** Multi-instance coordination not demonstrated; System Health covers the sequence sweep only; sequences ignore `Subscriber` consent (legal question).
13. **Production verification still required.** Disposable-PostgreSQL rehearsal; Docker build and smoke test; a live test with a test Gmail account (runbook); owner decisions.
14. **Decisions needed.** Typed model + rehearsal; contact-permission default; consent in sequence enrollment; single instance.
15. **Confirmation.** No deployment, no production database contact, no migration run, no real Gmail contact, no real email sent, no production environment change, no push (and the push URL is disabled).

## 3. Verification record (this audit)

| Check | Command | Result |
| --- | --- | --- |
| Type-check | `npx tsc --noEmit` | PASSED (no output) |
| Lint | `npx eslint src` | PASSED (0 errors, 0 warnings) |
| Prisma | `npx prisma validate` | PASSED |
| Full suite, run 2 | `npx vitest run` | 332 files passed, 1 failed, 57 skipped (390); 4,836 tests passed, **1 failed**, 1,119 skipped (5,956); 719 s |
| The one failure (runs 2 and 3) | `apply-sequence-gmail-check.test.tsx` "Check again" | **Root cause found - it was not a timeout:** the "Check again" button is disabled while the first check settles, and under a heavily loaded full run the test clicked it while still disabled, so the click was ignored (raising the wait from 5 s to 15 s did not help - it failed again in run 3). The test now waits until the button is enabled before clicking. No assertion was changed or removed. |
| Full suite, run 4 (final, after the fix) | `npx vitest run` | **333 files passed, 0 failed, 30 skipped (363); 4,837 tests passed, 0 failed, 582 skipped (5,419)**; 643 s. Run 3 (before the fix) had the one failure above. Note: run 2 listed 390 files / 1,119 skipped tests and runs 3-4 list 363 files / 582 skipped, and 363 is the number of test files on disk; the 27 extra files of run 2 were not identified (the build between the runs rewrote `.next`; this is an unverified explanation), so the database-gated count below is quoted from the final run. |
| Production build | `npm run build` (`next build`) | PASSED; routes include `/failed-signins` and `/subscriptions/campaigns/builder`; 3 pre-existing Turbopack tracing warnings in `src/server/storage/local.ts` (dynamic filesystem access), none from this work |
| Secret scan | pattern scan of the 111 release files (keys, tokens, private keys, JWTs, database URLs with passwords, long secret assignments; values never printed) | 0 findings; no `.env`, log, backup, key or build artefact among the files |
| Dependency audit | `npm audit` (read-only; no fix applied; `package.json` / `package-lock.json` untouched) | 38 advisories (1 critical `proxy-addr` via the Cloudflare build tooling; 19 high; 18 moderate) - no change from this work; triage is in `DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` section 18 |
| Originals unchanged | SHA-256 comparison against the earlier baseline | `compass-tools`: 1,378 files identical; `Travel Agency Website`: 1,122 files identical; 0 mismatches, 0 missing |
| PostgreSQL integration | `INTEGRATION_DATABASE_URL` unset; no PostgreSQL listening locally | **BLOCKED**; commands in `DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` section 19.2 |
| Browser verification | - | **BLOCKED** (needs an approved local database and a sign-in path); manual checks in section 19.4 of the runbook |
| Real Gmail / provider | - | **NOT RUN** (not authorized); controlled-mock coverage in `gmail-send.test.ts`, `campaign-worker.test.ts`, `sequences.test.ts` |

**Skipped tests:** 30 files / 582 tests (final run) are the database-gated suites (`*.integration.test.ts` and `reference-data.test.ts`), which skip themselves unless `INTEGRATION_DATABASE_URL` points at the approved disposable database. They were skipped, not passed. Nothing was excluded from the run and no test was disabled or weakened; one test's wait tolerance was raised and one test fake was made more faithful (it now honours `currentStepIdx` like the real WHERE clause).

## 4. Ready for a controlled redeployment?

**Not yet.** Blockers: (1) PostgreSQL rehearsal of the migration `20261120000100_security_privacy_marketing_scale` and the new SQL (reveal counter, claims, import cursor) on an approved disposable database; (2) a live Gmail check on a test account; (3) owner decisions: staff notification emails with complete customer addresses, Marketing Agent visibility of subscriber lists, a bulk provider before large campaigns, the 400/day and 20/min defaults, subscriber search design; (4) a browser pass of the new screens; (5) the release must reach `origin/main` through GitHub, because `deploy/deploy.sh` accepts only commits on `origin/main` and this checkout cannot push. After those, follow `DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` section 19.

## 5. Optional improvements (not blockers)

Show the `subscriber-imports` and `campaigns` jobs on System Health; subscriber search by email designed together with a "select all matching" bulk delete that deletes exactly what is shown; a typed delivery-state model for sequences; a per-instance lock for multiple app instances.

## 6. Git

Recorded in the final report of the audit and in the commit message: commit SHA, branch, push result.
