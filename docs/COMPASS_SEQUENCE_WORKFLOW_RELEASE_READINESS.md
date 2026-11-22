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
| Full suite, run 7 (release branch, FINAL, 2026-11-22 after the release-branch deployment work and the documentation) | `npx vitest run` with Git's `bash` on the path (366 files) | **336 files passed, 0 failed, 30 skipped; 4,930 tests passed, 0 failed, 572 skipped**; 343 s. Run 6 (before the CI-filter assertion was updated) had two failures: `selfhost-deployment-config.test.ts` pinned the old branch list of `ci.yml` and was updated deliberately (it now also asserts read-only permissions and no `pull_request_target`/write scopes); `campaign-builder-and-panels.test.tsx` "Save draft" timed out once under load (6.8 s test, 1 s `waitFor`) and passed 18/18 in isolation and in run 7 - a timing flake, nothing was changed for it. The 30 skipped files are the database-gated ones described below. |
| Release-branch static checks (run after the last change) | `npx tsc --noEmit`; `npx eslint src scripts`; `npx prisma validate` + `prisma generate` (7.10.1); `bash -n deploy/*.sh` | all PASSED (exit 0; `shellcheck` is not installed locally - CI runs it on `deploy/*.sh`) |
| Dependency audit (release branch) | `npm audit` (read-only) | 14 advisories (8 high, 6 moderate, 0 critical) - unchanged |
| Secret scan (release branch) | pattern scan of the 359 files the branch changes relative to `main` plus uncommitted files of this task (other-session files excluded) | 0 real findings; 9 pattern hits are all placeholder fixtures in tests (`SECRET = "..."` constants, `postgresql://...@example.com` style URLs in `db-tls.test.ts`); no `.env`, log, backup, key or build artefact among the files |
| Production build | `npm run build` (`next build`), run after the last change | PASSED; routes include `/failed-signins` and `/subscriptions/campaigns/builder`; **no warnings** (the three Turbopack tracing warnings in `src/server/storage/local.ts` were real - an environment-controlled path made the bundler trace the whole project into the standalone output - and are fixed with `/*turbopackIgnore: true*/`, comments only) |
| Secret scan | pattern scan of the 111 release files (keys, tokens, private keys, JWTs, database URLs with passwords, long secret assignments; values never printed) | 0 findings; no `.env`, log, backup, key or build artefact among the files |
| Dependency audit | `npm audit` (read-only), before and after targeted in-range updates (no `--force`, no range changes); `docs/DEPENDENCY_AUDIT_2026-11-22.md` | **38 (1 critical, 19 high, 18 moderate) -> 14 (0 critical, 8 high, 6 moderate)**; the remaining 14 are the Cloudflare Workers build tooling, the shadcn CLI and the Prisma CLI's `effect` dependency - none imported by the running application, none with a safe in-range fix; each is analysed in the document. Prisma 7.9.1 -> 7.10.1 was part of it and is covered by the database gate |
| Originals unchanged | 2026-11-20: SHA-256 comparison against the earlier baseline - original CRM 1,378 files and original website 1,122 files identical, 0 mismatches, 0 missing. **2026-11-22: NOT re-confirmed byte for byte** - the baseline hash lists lived in a temporary scratch folder that no longer exists, so the comparison cannot be repeated and no byte-for-byte claim is made for today. What can be said: no file in the original CRM (outside `.git`, `node_modules`, `.next`) has a modification time after 2026-11-14, nothing in this pass wrote outside `compass-tools-updated` and the audit-notes folders, and the original CRM's own `.git/config` is unreadable (pre-existing damage, not touched). To make the check repeatable, store a hash list inside the project documentation next time. |
| PostgreSQL integration | `INTEGRATION_DATABASE_URL` unset; no PostgreSQL listening locally | **BLOCKED**; commands in `DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` section 19.2 |
| Browser verification | - | **BLOCKED** (needs an approved local database and a sign-in path); manual checks in section 19.4 of the runbook |
| Real Gmail / provider | - | **NOT RUN** (not authorized); controlled-mock coverage in `gmail-send.test.ts`, `campaign-worker.test.ts`, `sequences.test.ts` |

**Skipped tests (final run):** 31 files / 587 tests: 29 `*.integration.test.ts` files (28 earlier ones plus `src/server/marketing/__integration__/campaign-and-import.integration.test.ts`), `src/server/queries/__tests__/reference-data.test.ts` and one more database-gated file. All skip themselves (`describe.skipIf(!enabled)`) unless `INTEGRATION_DATABASE_URL` points at the approved disposable database (`compass_test` on loopback, checked by `src/test/integration-database-guard.ts`). They were skipped, not passed. There is no `it.skip`, `describe.skip` or `it.todo` anywhere in the repository. Nothing was excluded from a run except build and tooling folders (`vitest.config.ts`). No test was disabled or weakened; two tests had their expectations updated for deliberate behaviour changes (the logging category and the notification privacy, which now has its own tests), one test's wait now checks the button is enabled, and test fakes were made more faithful (`currentStepIdx`, recipient lookup).

## 4. Ready for a controlled redeployment? (decision of 2026-11-22)

**Release branch `release/compass-tools-2026-11-22` (section 7): ready for REVIEW; NOT ready for redeployment.** For a controlled redeployment the verdict is **NOT READY**. Not because of the code that was written or the tests that ran - all of that passes - but because two release gates that this machine cannot run are still open, and the project's own rule is that essential database behaviour must be verified before redeployment:

1. **PostgreSQL gate - BLOCKED.** The new migration, the atomic reveal counter, the campaign claims and the import cursor have only been run against in-memory fakes; the Prisma client / driver adapter changed version (7.9.1 -> 7.10.1). No approved disposable PostgreSQL exists here (no PostgreSQL, no Docker). The CI `tests` job is the approved gate (`npm ci`, `prisma migrate deploy`, migration drift check, the whole suite with the database-backed files enabled) and must be green on the pull request.
2. **Publication - BLOCKED.** The checkout's push URL is deliberately `DISABLED-NO-PUSH` (set in `.git/config` on 2026-11-09; the fetch URL is the GitHub repository); the commits are local. `deploy/deploy.sh` now also accepts an explicitly named release-branch commit (section 7 below), but the branch still has to reach GitHub, from a machine or with an explicit approval that enables pushing, before CI can run on it.

Open but not blocking the code: a live Gmail check on a test account (needs your approval to send even one message); a browser pass of the authenticated screens (no approved local database and sign-in needs Google; only the signed-out gate was checked in a real running build); owner decisions (Marketing Agent visibility of subscriber addresses, a bulk provider before large campaigns, the 400/day and 20/min defaults, subscriber-search design, retention and consent policy). **No critical dependency advisory remains; 14 (8 high, 6 moderate) remain in build/CLI tooling and are analysed in `DEPENDENCY_AUDIT_2026-11-22.md`.** After the gates, follow `DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` section 19.

## 5. Optional improvements (not blockers)

Done in the release consolidation: subscriber search by email with an exact "select all matching" delete, and a strict atomic campaign quota (see section 7). Still open: a reveal flow for subscribers (needs a decision and a migration); a typed delivery-state model for sequences; a provider send adapter with bounce/complaint intake (after the provider decision in `COMPASS_CAMPAIGN_SENDING_CAPACITY.md`); move build-only tools out of `dependencies`.

## 6. Git

Recorded in the final report of the audit and in the commit message: commit SHA, branch, push result. The release branch is described in section 7.

## 7. Release branch `release/compass-tools-2026-11-22`

**Branch and ancestry.** Built on the tip of `review/crm-verification-2026-11-13` (`85a5272`) with no cherry-pick and no rebase; it contains that branch's whole history and the older GitHub copy of it (`3640790`). **`main` was not touched** (`main` = `origin/main` = `5a77976`, an ancestor of the release branch, 0 commits behind); nothing is merged into it. A document cannot contain the SHA of the commit that contains it: **the release SHA is the tip of the branch** (`git rev-parse release/compass-tools-2026-11-22`; the final report of the publishing session states it, and `git ls-remote origin refs/heads/release/compass-tools-2026-11-22` shows what GitHub holds). The same applies to publication and CI status: this document is part of the pushed commit and cannot state the outcome of pushing it. Read both from GitHub (`deploy/deploy.sh --release-branch` reads the check results itself).

**What the branch holds beyond GitHub's review branch (`3640790`)**, each commit checked against its diff:

| Commit | Content |
| --- | --- |
| `2849a58` | failed sign-in log, customer email privacy, scalable subscriptions and queued campaign delivery, sequence hardening |
| `b70b250` | targeted in-range dependency updates (38 -> 14 advisories) |
| `6d9cfee` | staff notification emails honour the customer-email reveal restriction |
| `4cf4806`, `85a5272` | System Health row, import size in bytes, test discovery, build warnings, env docs; documentation precision |
| `8dde3fc`, `a89f5ea` | release-branch deployment mechanism (`deploy/release-policy.sh`, `deploy.sh --release-branch`, CI `release/**` filter), release documentation |
| `33d5fcf` | **website request signing v2** (single-use, bound to method, path, company and body), CRM-first rollout switch `WEBSITE_SIGNATURE_REQUIRED`, key rotation `LEAD_INGEST_SECRET_PREVIOUS`, per-visitor limiter (the previously uncommitted work of another session, approved, reviewed and integrated) |
| `877a8fa` | **search** by complete email, phone digits and full name without exposing restricted addresses; **subscriber** address masking and exact-address search; "select all matching" scoped to the search |
| `492aea0` | **atomic per-sender campaign quota** (advisory lock), RFC 8058 **one-click unsubscribe** headers and endpoint |
| `e647e95` | `wrangler` 4.166.0 and `@opennextjs/cloudflare` 1.20.18 (npm audit 14 -> 9), Gmail `dailyLimitExceeded` handling and provider-outcome tests |
| later | CI checkout hardening (`persist-credentials: false`), capacity recommendation document, these documents |

**Other session's uncommitted work.** Of the 21 paths found earlier, **19 were the website-signing work** (the verifier, guard, three routes, the limiter, the body reader, the visitor-context refactor, the submission-info builders, their tests, `.env.example`, `docs/WEBSITE_LEAD_API.md` and the compatibility report) and are now committed after review (`33d5fcf`); my earlier classification of three of them as "contact IP geolocation work" was wrong: reading the diffs showed every hunk is part of signing v2. **Two paths remain uncommitted and untouched**: `docs/CRM_CONTACT_INQUIRY_IP_GEOLOCATION_VERIFICATION.md` (a dated 2026-11-13 verification note of earlier work) and `docs/recovery-archive/` (historic recovery evidence). Nothing was stashed, reset or discarded.

**Deployment mechanism** (prepared, never run). `bash deploy/deploy.sh --release-branch release/<name> --ref <full 40-character commit id> [--migrate] [--ci-attested]`: refuses any branch that is not `release/<name>`, any `--ref` that is not a full commit id, any commit that is not on the freshly fetched release branch, and any commit for which the GitHub Actions app does not report all three required checks green; never uses or changes `main`; never runs on a push; keeps every earlier protection. Rollout order for the website contract: **CRM first** (secret set, `WEBSITE_SIGNATURE_REQUIRED` unset), **website second**, then set `WEBSITE_SIGNATURE_REQUIRED=true` (`docs/WEBSITE_LEAD_API.md`).

**Remaining limitations, classified.**

| Item | Class |
| --- | --- |
| Types, lint, build, full unit suite, shell syntax, secret scan (section 3) | Resolved and verified |
| Customer-email privacy: Administrator unlimited, per-user unlimited switch (Administrator-only, same company, audited, step-up on grant), masked address + 5 reveals per business day for everybody else, staff notifications, mixed recipients, unreadable permission treated as restricted | Resolved and verified (unit tests with fakes; the reveal counter's concurrency against real PostgreSQL is in the CI database job) |
| Search by complete email (exact, primary and secondary addresses), phone digits and full/partial name for Contacts, Leads, Quotes, task links; fragment search stays closed to restricted viewers | Resolved and verified (in-memory evaluation of the actual filter); a fragment search by a restricted viewer is **deliberately not offered** (oracle) |
| Subscriber addresses masked for a viewer without full-address access, exact-address search, "select all matching" scoped to the search | Resolved and verified (unit tests). **No reveal flow for subscribers** (a reveal needs its own allowance table, a migration and an audit trail): Requires user decision |
| Website signing v2, CRM-first switch, key rotation, per-visitor limiter (20 per 15 minutes per verified visitor IP; account budget unchanged) | Resolved and verified at unit level; the nonce INSERT and limiter against real PostgreSQL are Open release blockers until the CI database job is green; the 20/15-minute default is an existing allowance reused: Requires user decision |
| Concurrent campaign workers overshooting a limit | Resolved by code (atomic claim under an advisory lock); verified against an in-memory stand-in only: Resolved but not independently verified until the CI database job runs the new real-database test |
| Campaign sending capacity (Gmail 2,000/day per user shared with all mail, relay, providers, costs) | Requires user decision: `COMPASS_CAMPAIGN_SENDING_CAPACITY.md` |
| One-click unsubscribe headers and endpoint | Resolved and verified by unit tests; the header in a real Gmail inbox: Requires production verification (one approved test email) |
| Single app instance | Open improvement: claims are database-level and safe across instances in design, but only a database test proves it; keep ONE instance until the CI result is seen |
| Prisma 7.10.1, the migration, drift, every database-gated suite (30 files, 572 tests skipped locally) | Resolved but not independently verified; **Open release blocker until GitHub Actions completes the database job successfully for the release commit** |
| 9 `npm audit` advisories (3 high, 6 moderate, 0 critical; none in the production image) | Open improvement (`DEPENDENCY_AUDIT_2026-11-22.md`, one row per advisory) |
| Real Gmail behaviour (quota, refresh, ambiguous outcomes) | Requires production or external-provider verification |
| Consent and retention policy for subscribers and imports | Requires user decision |
| Import limits (250,000 rows / 4 MB) against server capacity | Requires production verification (not a throughput guarantee) |
| Monitoring: System Health and logs only; no external alerting; no bounce/complaint feedback on the Gmail path | Open improvement |
| ShellCheck | Not installed locally; runs in CI on `deploy/*.sh` |
| Originals (byte-for-byte) | Unavailable: no manifest exists in the F: workspace; the original CRM's `.git/config` is unreadable, the original website has 32 uncommitted entries from before this work, and no file in either was modified after 2026-11-13; nothing was written to them |
| CRM/website rollout order | Resolved (documented, switch implemented); Requires production verification |
