# Remaining Sequence Delivery Limitations and Improvements

Date: 2026-11-20. Scope: `compass-tools-updated`. No deployment, no database, no real Gmail, no migration, no commit/push for this task. Status words: IMPLEMENTED / PROPOSED / VERIFIED (mocked or fake DB) / NOT VERIFIED / BLOCKED / NOT RUN.

## 1. Verified starting state

| Item | Result |
| --- | --- |
| Branch / HEAD | `review/crm-verification-2026-11-13` at `364079044f246dbaa62f0f8f84ba1bb478a5ad6e` when this document was first written (that is also where GitHub's copy of the branch still is); later commits sit on the same branch and on `release/compass-tools-2026-11-22` - see `COMPASS_SEQUENCE_WORKFLOW_RELEASE_READINESS.md` section 7, which also classifies every remaining limitation |
| Reported commit present? | Yes - local HEAD equals it. |
| Remote | `https://github.com/jasurkhonazizkhonov-source/Compass-Tools` branch tip = the same commit (via `git ls-remote`); `main` = `5a77976`, untouched. The remote did not differ. |
| Merge / rebase / cherry-pick | none in progress; `stash@{0}` untouched |
| Uncommitted work that is NOT part of this task | modified: `.env.example`, `docs/WEBSITE_LEAD_API.md`, `src/app/api/public/subscribe/route.ts`, `src/app/api/v1/website/flight-inquiries/{route.ts,__tests__/route.test.ts}`, `src/server/{inquiry-submission-info,lead-ingest-context,lead-submission-info,public-inquiry}.ts`, `src/server/security/{rate-limit,read-limited-json}.ts` and tests; untracked: `src/app/api/public/__tests__/website-signed-routes.test.ts`, `src/server/__tests__/website-request-signature.test.ts`, `docs/CRM_CONTACT_INQUIRY_IP_GEOLOCATION_VERIFICATION.md`, `docs/CRM_WEBSITE_API_COMPATIBILITY_VERIFICATION.md`, `docs/recovery-archive/`. They come from another session (website signed-request work); **left untouched**. |
| Previous reports read | `CRM_GMAIL_CONNECTION_AND_SEQUENCE_ENROLLMENT_AUDIT.md`, `CRM_SEQUENCE_RETRY_AND_DUPLICATE_PREVENTION_AUDIT.md`, `CRM_SEQUENCE_AUTOMATIC_SENDING_VERIFICATION.md`, `CRM_SEQUENCE_LEAD_STATUS_AND_UI_CONSISTENCY_AUDIT.md`, `CRM_PRODUCTION_READINESS_REASSESSMENT.md`, `CRM_GITHUB_RELEASE_REPORT.md`; their claims were re-checked against source (sections 2-6). |

## 2. Previous claims checked against the current source

| Claim | Verified |
| --- | --- |
| Gmail readiness distinguishes 4 failures and refuses wrong-company senders | Yes (`gmail-send.ts`, `sequence-enrollment-eligibility.ts`; `gmail-readiness-states.test.ts`, `sequences.test.ts` "Scenario A"). |
| Return-to-lead is allow-listed | Yes: `/leads/<id>` only, validated when set and again in the callback (`gmail-oauth-state.ts`; 11 + 3 tests). |
| Sends have a timeout; ambiguous results never auto-resend; unreadable 2xx is a success | Yes. |
| Write-ahead markers + hold | Yes (`due-sequence-steps.ts`). |
| `readiness.sequenceScheduler` exists and cannot report running while failing | Yes (unit tests + the earlier real-server run). |
| Lead and sequence pages show one derived state | Yes (`deriveEnrollmentState`). |
| **Recovery actions are properly authorized** | **Partly wrong.** They checked access to the *sequence*, not to the *lead*; see 5.1 (fixed). |

## 3. Defects found and fixed in this task

1. **Lease-ownership race in the sweep (IMPLEMENTED).** The pre-send eligibility update re-wrote the lease without checking it was still the worker's own; a worker that stalled longer than the 2-minute lease between claim and marker insert could send after another worker had taken the row over -> possible duplicate. It now requires `nextSendAt = <my lease>` and renews the lease for the send. Test: "lease ownership..." (the second worker runs inside the first worker's stall; one email in total). Still **only against the fake database**.
2. **Recovery/unenroll did not check the lead (IMPLEMENTED).** `retryEnrollmentNow`, `resolveUncertainDelivery` and `unenrollLead` only required access to the sequence. A lead reassigned to another agent/team (or otherwise outside the caller's row-level scope) could still be acted on - including **sending mail from the lead's current agent's Gmail**. They now also require the lead to be visible under `leadVisibilityWhere` (company, assigned agent, manager team); the answer is the generic "not found".
3. **Poller shutdown and observability (IMPLEMENTED).** The poller moved to `src/server/background-poller.ts`: `stopBackgroundPoller()`, SIGTERM/SIGINT stop new runs, the timer never keeps the process alive, errors are recorded as a category only (`lastErrorTag`), `lastSuccessAt` is tracked.
4. A TypeScript type in the sweep that diverged from the real client (global `omit` rules) was replaced by a type derived from the real query.
5. A UI test that was timing-sensitive under full-suite load now waits longer (it passed 3/3 alone).

**Corrections made in the completion audit (2026-11-20, second session):**

6. **Stale worker could overwrite newer state (IMPLEMENTED).** After a send, the enrollment updates (advance to the next step, mark FAILED, schedule a retry, hold as unknown) were conditional only on `status = ACTIVE`. A worker that outlived its lease (a hanging provider call) could therefore overwrite what a newer worker, a person's restart or a resolve had written in the meantime. They are now also conditional on `currentStepIdx` - the step the worker read. A duplicate email was already prevented by the in-flight marker (a second worker finds it and holds); this closes the state-overwrite half. Tests: "lease lost DURING the send", "a stale worker's post-send write does not overwrite a newer state", "a stale worker's FAILURE handling also leaves a newer state alone" (the fake database now honours `currentStepIdx` exactly as the real WHERE clause does).
7. **Shutdown mid-run (IMPLEMENTED).** SIGTERM / `stopBackgroundPoller()` set a flag that a sweep already in flight checks between enrollments and between batches, so it stops taking new work instead of sending for minutes after the process was told to exit (the unit already underway is left to finish or is recovered by the marker). Test: "after a shutdown is requested no further enrollment is picked up". The flag is cleared on the next start.
8. **Poller logged the whole error object (IMPLEMENTED).** The comment promised a category only, the code logged the error (which can carry a connection string, a recipient or message text). It now logs `safeErrorTag` only; the two existing tests that asserted the old form were rewritten to assert the safe form and that the message text is absent.
9. Still true, stated plainly: the claim / lease / marker logic is exercised against an in-memory fake only; **PostgreSQL behaviour is BLOCKED** (no approved disposable database exists). The System Health row "Automatic sequence sending" covers the sequence sweep; the `subscriber-imports` and `campaigns` jobs now have their own row, "Subscriber imports and campaign delivery" (added 2026-11-22, same state source, tested).

## 4. Scheduler findings

| Question | Finding |
| --- | --- |
| Starts as intended? | `register()` starts one interval in the Node runtime only, once per process; the flag values are tested. |
| Interval correct? | 60 s (`POLL_INTERVAL_MS`); a test drives 1 s intervals through the same code. |
| Overlap in one process? | Prevented per job (skip while running; stuck after 10 min -> replacement allowed). Tested. |
| Several app instances? | **Not coordinated.** Safety rests only on the row-level claim (+ the new lease check + the marker). In PostgreSQL that claim is atomic, but this is **not demonstrated here**; run **one app instance** until it is. No new queue/Redis/lock service was introduced. |
| Restart recovery? | All state is in the database; expired leases make rows due again; markers hold unknown outcomes. Tested against the fake. |
| Crashed worker leaves things stuck? | Not permanently: lease expiry (2 min) -> re-pickup; an abandoned in-flight send becomes UNKNOWN and waits for a person (by design). |
| One failing enrollment blocks others? | No: per-enrollment try/catch; error category logged. Not persisted per enrollment (the in-flight marker is the per-enrollment record). |
| Shutdown? | New runs stop on SIGTERM/SIGINT; an in-flight sweep takes no further enrollment or batch (see 3.7); a run underway is not awaited (an unrecorded send is held as UNKNOWN next time). |
| Health can look healthy while not progressing? | "Running" needs a finished run within 3 minutes; a failing last run is "stalled"; a started-but-silent poller is "stalled" after 3 minutes. Limit: per process - another instance has its own record, and a **page request answered by a different instance than the sender** would show that instance's state. |

## 5. System Health interface (IMPLEMENTED)

A new row **"Automatic sequence sending"** in the existing System Health catalogue (`checkSequenceScheduler` in `src/server/system/health-checks.ts`, rendered by the existing view, no layout change), read from the same state as `/api/health` (`sequenceSchedulerReport`):

| State | Shown as | Guidance |
| --- | --- | --- |
| running | Healthy | "running: a run completed recently"; facts: enabled Yes, operational Yes, last successful run (UTC), last run counts |
| disabled | Warning (manual action) | switched off by `DISABLE_IN_PROCESS_POLLER`; make sure `/api/cron/sequences` is called each minute |
| stalled | Critical | last run failed (error **category** only, consecutive failures) or silent; recovers by itself |
| not started / unknown | Unknown | wait a minute after a restart; check the log |

Tests: `src/server/system/__tests__/health-checks-scheduler.test.ts` (7), `src/server/__tests__/background-poller.test.ts` (7), `src/__tests__/instrumentation-poller.test.ts`. Not done: a sequence-screen banner (the System Health page is the single place).

## 6. Gmail findings (mocked verification only)

All 18 items of the task checklist were checked against the code and the existing tests. Items 1-12 hold as reported. 13-14 (retry re-verifies Gmail; same enrollment): yes. 15, 17 (authorization of resolution): **fixed** (5.2 above) and covered by new negative tests. 16: the "Send again" confirmation warns of two copies (UI test). 18: one derived state, parametrized test. **Real Gmail was not contacted**; real OAuth, token refresh, scope behavior and Sent-folder reconciliation are listed in the production runbook.

## 7. Authorization and tenant isolation (IMPLEMENTED + VERIFIED against the fake)

New negative tests in `sequences.test.ts` ("authorization of sequence start, recovery and cancel actions"): a lead the caller cannot see -> retry / resolve (sent, resend) / unenroll refused with "not found" and nothing changes or is sent; the readiness check reveals nothing about such a lead (no sender name, Gmail not even asked); starting for such a lead creates nothing; ticketing / flight-expert / marketing roles and an anonymous caller are refused everywhere; a sequence created by another company is "not found"; a **cross-company sender** is refused before Gmail is asked; errors contain no token, credential, subject or recipient; resolution is audited with the actor and without the email address. Viewing delivery details on the lead/sequence pages relies on the pages' own row-level queries (unchanged). Connect/Reconnect always acts on the signed-in account only.

## 8. Privacy and consent (CRM side; no legal conclusions)

- The CRM stores marketing consent only on **`Subscriber`** (status SUBSCRIBED/UNSUBSCRIBED, `source`, `subscribedAt`, `unsubscribedAt`, one-click token, optional reason). **Leads/Contacts carry no marketing-consent or do-not-contact field**; card storage has its own `consentGivenAt`.
- **Sales sequences do not consult `Subscriber` status or any consent flag**: enrollment checks visibility, a valid recipient, an assigned agent and Gmail; each sequence email carries its own unsubscribe link, which sets that enrollment `UNSUBSCRIBED` only. A person who unsubscribed from the marketing list (or whom nobody has opted in) can still be enrolled in a sales sequence. Whether that is acceptable is a **legal/business question, not decided here**.
- No agreed API contract for consent data between the website and the CRM was found in the CRM (the website-signed visitor-context contract covers IP/location, not consent). The website privacy-policy wording remains a separate website/legal review. No consent records, checkboxes or legal text were invented or changed; the website was not touched.

## 9. Changes deliberately not made

The typed delivery-state migration (proposed in `COMPASS_SEQUENCE_DELIVERY_AND_CONTACT_PERMISSION_MIGRATION_READINESS.md`, needs owner approval and a PostgreSQL rehearsal); multi-instance coordination (needs evidence on PostgreSQL); a sequence-screen scheduler banner; any consent check in sequence enrollment (needs a business/legal decision).

## 10. Test results (this task)

| Check | Result |
| --- | --- |
| `tsc --noEmit`, `eslint .`, `prisma validate` | PASSED |
| Full Vitest (run 1, after all prompt-1 code except the final lease fix) | 4,560 passed, **1 failed** (the timing-sensitive UI test above; fixed, 3/3 alone), **1,099 SKIPPED** (database-gated, 55 files) |
| Focused after the fixes: `sequences.test.ts` | 98 passed |
| New files: `sequence-delivery-state.test.ts` (all 25 transition pairs, legacy mapping, never-auto-resend rule), `contact-permission-migration.test.ts` (8), `background-poller.test.ts` (7), `health-checks-scheduler.test.ts` (7) | PASSED |
| Database-backed tests, real PostgreSQL locking/claim behavior, real Gmail, multi-instance | **SKIPPED / BLOCKED / NOT RUN** |

## 11. Outstanding decisions

Approve the typed model and a rehearsal; contact-permission default (true vs default-deny); whether sequences must honour `Subscriber`/consent (legal); single instance until multi-instance is demonstrated.
