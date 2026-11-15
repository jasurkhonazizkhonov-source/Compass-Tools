# CRM Sequence Automatic Sending Verification

Date: 2026-11-16. Scope: `compass-tools-updated`. Production, the VPS, its timers, its environment and its database were not touched. Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. Existing functionality verified (re-read in the current source, not assumed from the previous report)

| Item | Finding |
| --- | --- |
| No manual "Process Due" for sequences | The button component (`process-due-button.tsx`) and the public action `processDueSequenceSteps` are **removed** in this task (the component was already unused; the action was a public Server Action with no UI). A test walks `src/components/sequences`, `src/components/leads`, `src/app/(crm)/sequences` and `src/app/(crm)/leads` for "Process Due Steps" / `processDueSequenceSteps` / `ProcessDueButton` and asserts the actions module exports nothing named `processDue*` (`due-work-authorization.test.ts`, PASSED). The **Tasks** page keeps its separate "Process Due Tasks" button (task reminders; out of scope, deliberately unchanged). |
| Background job startup | `src/instrumentation.ts` `register()` starts one 60 s interval in the Node runtime (never on the edge runtime), once per process (`globalThis.__taskNotifierStarted`). Each tick runs the **task-reminder sweep and the sequence sweep** as independent jobs. |
| `DISABLE_IN_PROCESS_POLLER` | `true` / `1` / `yes` / `on` (any case, trimmed) disables **both** jobs; any other value (`false`, `0`, `off`, `disabled`, empty) leaves them on. |
| Task reminders not disabled by the sequence work | the task job is unchanged and still runs on the same tick; a failure in either job does not stop the other. |
| Due-step selection | `status = ACTIVE`, `nextSendAt <= now`, `sequence.isActive = true`; an enrollment waiting for a person (`nextSendAt = null`) is never selected; batches of 50, drained up to 10 batches per tick. |
| Active / Inactive | an inactive sequence is skipped untouched (still ACTIVE, same step and time) and resumes when switched on. |
| Claim and re-check | atomic claim (2-minute lease) before any side effect; ACTIVE re-check immediately before the send, so an enrollment unenrolled before the send is never sent. |
| Retry | temporary failures: 10 min, 60 min, max 3 real failures since the last manual restart; permanent failures end the enrollment; unknown outcomes are held for a person (see the retry audit). |
| Restart | all scheduling state is in the database; a new process picks up due work; nothing in memory is required. |

## 2. Corrected / added in this task

- **Per-enrollment error isolation**: an unexpected exception for one enrollment is caught, logged by category only (`[sequence-sender] processing one enrollment failed (<tag>)`), and the sweep continues.
- **Write-ahead delivery marker and held-for-a-person state** (see the retry audit): the sweep no longer resends a step whose outcome is unknown.
- **Sends have a 30 s deadline** so a hung Gmail connection cannot occupy a worker for minutes.

## 3. Scheduler health: does `readiness.sequenceScheduler` tell the truth?

The field exists (`src/lib/health-check.ts`, backed by `src/server/scheduler-status.ts`) and is visible only to a caller presenting the `CRON_SECRET` bearer. Rule: `disabled` (poller off and no sweep seen in 3 minutes), `not_started`, `running` (a sweep finished within 3 minutes, or the poller started less than 3 minutes ago), `stalled` (started but silent for 3 minutes, **or the last sweep failed**).

**Runtime verification (real built server, `.next/standalone/server.js`, port 3290, deliberately unreachable dummy database, then stopped):**

| Run | Observed |
| --- | --- |
| poller on, ~100 s after start | `/api/health` (bearer) -> `readiness.sequenceScheduler = "stalled"`; log shows `[sequence-sender] drainDueSequenceSteps failed` (database unreachable). It did **not** report `running` while the job was failing. |
| `DISABLE_IN_PROCESS_POLLER=true` | `readiness.sequenceScheduler = "disabled"`, and no background-job log lines in 65 s. |

Not verified at runtime: the `running` state against a real database (none available); the unit tests cover it (`instrumentation-poller.test.ts`: `not_started` -> `running` -> `stalled` after 3 silent minutes, `disabled`, failure -> `stalled` -> recovery -> `running`). Honest limit: the field describes the **instance that answers**; with several instances each answers for itself. When `DISABLE_IN_PROCESS_POLLER` is on and an external timer calls `/api/cron/sequences` about once a minute, the field shows `running` only while it keeps doing so.

## 4. Is a lead ever shown as progressing automatically when no scheduler works?

The lead card shows the state and "Next email: <time>" from stored data and cannot know whether a scheduler is alive; the Sequences area is not currently wired to the health field. **Remaining limitation**: if the poller is disabled and nothing calls the cron route, an ACTIVE enrollment still displays its scheduled time. The only operator signal is `readiness.sequenceScheduler` (`disabled` / `stalled`) in the detailed `/api/health` response (bearer `CRON_SECRET`); it is **not** shown on the signed-in System Health page or inside the sequence UI (not implemented).

## 5. Deployment configuration (not changed, not applied)

`compose.yaml` does not set `DISABLE_IN_PROCESS_POLLER` (so the poller is on); `CRON_SECRET` is required by compose. `deploy/run-sequence-sweep.sh` and the `compass-tools-sequences` systemd units remain optional redundancy and are installed by nothing. Docker was **not** built or run (not installed). On Vercel's serverless runtime no long-lived process exists: a scheduler must call `/api/cron/sequences` once a minute.

## 6. Tests

| Suite | Result |
| --- | --- |
| `src/__tests__/instrumentation-poller.test.ts` (both jobs, flag values, once-only, edge runtime, failure isolation, overlap skip, stuck-run recovery, health states) | PASSED |
| `sequences.test.ts` "Scenario C" (every later step sent in order, once, no user action, ends COMPLETED), "Scenario D" (Unenroll: nothing more is sent, history kept), inactive/resume, two workers, restart, drain backlog | PASSED |
| `src/app/api/health/__tests__/route.test.ts` (`sequenceScheduler` category present in the detailed body only) | PASSED |
| Full Vitest | see the readiness reassessment |
| Real database claim/lock behaviour; real Gmail; Docker; production | NOT RUN / BLOCKED |
