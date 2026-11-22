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
| Staff notification emails (customer address) | READY LOCALLY | resolved 2026-11-22: recipients who may not see addresses get a note instead (no address, no mailto, no Reply); HTML only, no plain-text body exists; tested for the four builders and three senders |
| Subscriber import (background, 250,000 rows / 4 MB) | READY LOCALLY; PENDING DB REHEARSAL | in-memory database only |
| Campaign builder | READY LOCALLY | URL / HTML / personalization safety tested; not run in a browser |
| Queued campaign delivery | READY LOCALLY; PENDING DB REHEARSAL; PENDING GMAIL VERIFICATION | 33 worker tests on a fake DB + fake provider |
| Large-campaign capacity (Gmail) | REQUIRES USER DECISION | Gmail cannot send hundreds of thousands; needs an approved bulk provider |
| Marketing consent / retention of failed sign-in data / reveal policy | REQUIRES LEGAL REVIEW | nothing here is a legal conclusion |
| Browser verification of the new screens | BLOCKED (partly done) | a real production build was started with no database: every protected route (`/failed-signins`, `/leads`, `/subscriptions/campaigns/builder`) answered 307 to `/login` with `Cache-Control: private, no-cache, no-store`; authenticated screens need an approved database and Google sign-in |
| Real PostgreSQL behaviour (587 database-gated tests in the final run) | BLOCKED | skipped, not passed; no approved disposable database |
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
| Full suite, run 5 (FINAL, after every code and dependency change of 2026-11-22) | `npx vitest run` (365 files = every test file on disk; `npx vitest list --filesOnly` agrees) | **334 files passed, 0 failed, 31 skipped; 4,857 tests passed, 0 failed, 587 skipped**; 581 s. Run 4 (2026-11-20, before the notification, dependency and System Health changes): 333 / 0 / 30 files, 4,837 passed, 582 skipped. Runs 2-3 had the Check-again failure described above. Run 2 had listed 390 files (27 extra, all database-gated, all skipped, origin never identified); `vitest.config.ts` now excludes build and tooling folders. |
| Production build | `npm run build` (`next build`), run after the last change | PASSED; routes include `/failed-signins` and `/subscriptions/campaigns/builder`; **no warnings** (the three Turbopack tracing warnings in `src/server/storage/local.ts` were real - an environment-controlled path made the bundler trace the whole project into the standalone output - and are fixed with `/*turbopackIgnore: true*/`, comments only) |
| Secret scan | pattern scan of the 111 release files (keys, tokens, private keys, JWTs, database URLs with passwords, long secret assignments; values never printed) | 0 findings; no `.env`, log, backup, key or build artefact among the files |
| Dependency audit | `npm audit` (read-only), before and after targeted in-range updates (no `--force`, no range changes); `docs/DEPENDENCY_AUDIT_2026-11-22.md` | **38 (1 critical, 19 high, 18 moderate) -> 14 (0 critical, 8 high, 6 moderate)**; the remaining 14 are the Cloudflare Workers build tooling, the shadcn CLI and the Prisma CLI's `effect` dependency - none imported by the running application, none with a safe in-range fix; each is analysed in the document. Prisma 7.9.1 -> 7.10.1 was part of it and is covered by the database gate |
| Originals unchanged | SHA-256 comparison of the original CRM against the earlier baseline (re-run at the end of this pass) | see the final report |
| PostgreSQL integration | `INTEGRATION_DATABASE_URL` unset; no PostgreSQL listening locally | **BLOCKED**; commands in `DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` section 19.2 |
| Browser verification | - | **BLOCKED** (needs an approved local database and a sign-in path); manual checks in section 19.4 of the runbook |
| Real Gmail / provider | - | **NOT RUN** (not authorized); controlled-mock coverage in `gmail-send.test.ts`, `campaign-worker.test.ts`, `sequences.test.ts` |

**Skipped tests (final run):** 31 files / 587 tests: 29 `*.integration.test.ts` files (28 earlier ones plus `src/server/marketing/__integration__/campaign-and-import.integration.test.ts`), `src/server/queries/__tests__/reference-data.test.ts` and one more database-gated file. All skip themselves (`describe.skipIf(!enabled)`) unless `INTEGRATION_DATABASE_URL` points at the approved disposable database (`compass_test` on loopback, checked by `src/test/integration-database-guard.ts`). They were skipped, not passed. There is no `it.skip`, `describe.skip` or `it.todo` anywhere in the repository. Nothing was excluded from a run except build and tooling folders (`vitest.config.ts`). No test was disabled or weakened; two tests had their expectations updated for deliberate behaviour changes (the logging category and the notification privacy, which now has its own tests), one test's wait now checks the button is enabled, and test fakes were made more faithful (`currentStepIdx`, recipient lookup).

## 4. Ready for a controlled redeployment? (decision of 2026-11-22)

**NOT READY.** Not because of the code that was written or the tests that ran - all of that passes - but because two release gates that this machine cannot run are still open, and the project's own rule is that essential database behaviour must be verified before redeployment:

1. **PostgreSQL gate - BLOCKED.** The new migration, the atomic reveal counter, the campaign claims and the import cursor have only been run against in-memory fakes; the Prisma client / driver adapter changed version (7.9.1 -> 7.10.1). No approved disposable PostgreSQL exists here (no PostgreSQL, no Docker). The CI `tests` job is the approved gate (`npm ci`, `prisma migrate deploy`, migration drift check, the whole suite with the database-backed files enabled) and must be green on the pull request.
2. **Publication - BLOCKED.** The checkout's push URL is deliberately `DISABLED-NO-PUSH`; the commits are local. `deploy/deploy.sh` accepts only commits on `origin/main`, so the release has to be pushed from a machine with push rights, reviewed through a pull request and merged first.

Open but not blocking the code: a live Gmail check on a test account (needs your approval to send even one message); a browser pass of the authenticated screens (no approved local database and sign-in needs Google; only the signed-out gate was checked in a real running build); owner decisions (Marketing Agent visibility of subscriber addresses, a bulk provider before large campaigns, the 400/day and 20/min defaults, subscriber-search design, retention and consent policy). **No critical dependency advisory remains; 14 (8 high, 6 moderate) remain in build/CLI tooling and are analysed in `DEPENDENCY_AUDIT_2026-11-22.md`.** After the gates, follow `DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` section 19.

## 5. Optional improvements (not blockers)

Subscriber search by email designed together with a "select all matching" bulk delete that deletes exactly what is shown (design in the implementation report); a strict global campaign cap (needs a database lock and a PostgreSQL rehearsal); a typed delivery-state model for sequences; a per-instance lock for multiple app instances; move build-only tools out of `dependencies`.

## 6. Git

Recorded in the final report of the audit and in the commit message: commit SHA, branch, push result.
