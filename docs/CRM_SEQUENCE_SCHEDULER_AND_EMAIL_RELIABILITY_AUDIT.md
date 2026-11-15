# CRM Sequence Scheduler and Email Reliability Audit

Date: 2026-11-15. Scope: `compass-tools-updated`. Production, the VPS, its scheduled jobs and its environment were **not** touched; everything below is code reading plus tests against a fake database and mocked mail. Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. The previous blocker, and how it is resolved in code

**Finding (2026-11-13):** nothing in the VPS deployment called `/api/cron/sequences`; the in-process poller ran only task notifications. Enrolled leads would never receive step 2, 3, ... and even step 1 needed a manual button.

**Investigation of every mechanism that could run a sweep:**

| Mechanism | Does it send sequence steps? |
| --- | --- |
| `/api/cron/sequences` route | Yes when called (Bearer `CRON_SECRET`; refuses when unset in production). **Nothing called it** on the VPS (`compose.yaml`, `deploy/*`, systemd units, CI) or on Vercel (`vercel.json` lists only `/api/cron/tasks`). |
| In-process poller (`src/instrumentation.ts`) | Before: only `runDueTaskNotifications`. **Now: both jobs, every 60 s.** |
| `deploy/run-daily-maintenance.sh` + timer | Calls `/api/cron/tasks` daily; not sequences (unchanged, and not needed). |
| "Process Due Steps" button | Removed from the UI (a manual, unreliable step). |

**Resolution (no second scheduler introduced):** the existing poller, which the self-hosted deployment already depends on (Docker `node server.js` runs `register()`; on by default), now also calls `drainDueSequenceSteps()` on every tick. A new optional external trigger (`deploy/run-sequence-sweep.sh` + `deploy/systemd/compass-tools-sequences.{service,timer}`) is provided **but not installed or enabled by anything**; it is only needed as a redundant trigger or if the poller is switched off.

**Answer to "will automatic sending run in production without manual processing?"** On the self-hosted Docker/VPS deployment: **yes in design**, as soon as this code is deployed with `DISABLE_IN_PROCESS_POLLER` unset (the default) - the server process itself sends due steps every minute. This is **not proven in production**: no deployment was made, Docker was not built, no database was available. On Vercel (serverless) it would **not** run unless a scheduler calls `/api/cron/sequences` once a minute (Vercel Hobby cron is once a day at best).

## 2. Behaviour of the scheduler (verified by tests)

| Requirement | How it is met | Evidence |
| --- | --- | --- |
| Due steps processed automatically, often enough | 60 s tick; each tick drains up to 10 batches of 50 due enrollments (500 per tick) so a backlog is worked off, not 50 per minute | `drainDueSequenceSteps` test: 120 due enrollments sent in one call, 3 batches, none twice - PASSED |
| No double send across workers/instances | each enrollment is **claimed** with a conditional update (`WHERE id, status=ACTIVE, nextSendAt = the value read`) that pushes `nextSendAt` 2 minutes ahead before any side effect | concurrency tests against the fake - PASSED; real PostgreSQL - NOT RUN |
| Overlapping ticks in one process | a job still running when the next tick fires is skipped; the two jobs are independent | poller tests - PASSED |
| Restart loses nothing | all state is in the database (`nextSendAt`, step, status); a restarted process simply continues; a row claimed by a crashed worker becomes due again when its 2-minute lease expires | by design; restart behaviour **NOT RUN** against a real process |
| Temporary provider failure | retried on the same step after 10 min, then 60 min, at most 3 attempts; the step does not advance on failure | PASSED |
| Permanent failure (Gmail not connected / authorization expired) | enrollment becomes `FAILED`, visible, no retries | PASSED |
| Inactive sequence | its due enrollments are skipped untouched and resume when switched on | PASSED |
| Unenrolled / unsubscribed | the sweep only reads `ACTIVE`; a send-time re-check (conditional update on `ACTIVE`) stops a worker that had already claimed the row | PASSED against the fake |
| Failure of one job does not stop the other or the interval | separate promises, caught and logged; status recorded | PASSED |
| Idempotent first send on approval | `ALREADY_ENROLLED` on repeat; claim on the send | PASSED |

## 3. Monitoring

- **New `readiness.sequenceScheduler`** in the detailed `/api/health` (Bearer `CRON_SECRET` only; categories only): `running` (a sweep finished in the last 3 minutes), `not_started`, `stalled` (started but silent for over 3 minutes, or the last sweep failed), `disabled` (poller switched off and nothing has called the cron route recently). Backed by `src/server/scheduler-status.ts` (counts, times, pass/fail only - never a recipient or message). It describes the instance that answers; a second instance has its own record.
- Failures are logged as `[sequence-sender] drainDueSequenceSteps failed` (error object, no recipient). Per-step history stays in `SequenceStepLog` / `EmailLog` / lead activity (`SEQUENCE_FAILED`).

## 4. Residual risks (stated, not hidden)

1. **At-least-once, not exactly-once, around a crash.** If the process dies after Gmail accepts a message but before the `SENT` log and the step advance are written, the lease expires after 2 minutes and the step is sent again. A database-level guarantee would need a unique constraint (for example a partial unique index on `SequenceStepLog (enrollmentId, stepId) WHERE status = 'SENT'`) plus writing an intent row before sending; that is a **schema migration and was not made** (approval needed). The window is the few milliseconds between the provider's answer and two small writes.
2. **Lease shorter than a send.** The claim lease is 2 minutes. A send that hangs longer than that (no explicit provider timeout was found in `sendEmail`) could be claimed by another tick/instance and sent twice. Mitigation proposed and implemented in this change: a stuck run does not block the poller forever (see section 6).
3. **Unenroll versus an email already in flight.** Unenroll is a conditional update; the worker re-checks `ACTIVE` immediately before the provider call. Nothing can send **after the unenroll has committed**, except an email that had already been handed to Gmail when it committed - that email cannot be recalled. Closing that window entirely would require holding a database lock across the external call.
4. **No send-rate limit.** Sequence sends are sequential (about one per provider round trip); there is no per-agent daily cap. Gmail's own limits apply and produce a temporary failure that is retried with backoff.
5. **Real database behaviour is unverified**: advisory locks, the conditional-update claim and transaction timeouts were exercised only against an in-memory fake.
6. **Vercel**: not a supported place for automatic sequences without an external once-a-minute caller.

## 5. Proposed production configuration (NOT applied)

The default needs **no** VPS change: deploy this code; leave `DISABLE_IN_PROCESS_POLLER` unset. After deploying, check with `Authorization: Bearer $CRON_SECRET` on `/api/health` that `readiness.sequenceScheduler` is `running` within about two minutes (`deploy/verify.sh` already reads the detailed health from inside the container).

Optional redundancy (the operator installs it deliberately):

```bash
sudo cp deploy/systemd/compass-tools-sequences.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now compass-tools-sequences.timer
```

If the poller is ever disabled, the timer above is **required**, and `readiness.sequenceScheduler` shows `running` only while it keeps calling the route.

| Question | Answer |
| --- | --- |
| Which service executes the sweep | the app container's own Node process (poller); optionally systemd -> `docker compose exec app` -> `/api/cron/sequences` |
| How often | every 60 s (poller); every minute (optional timer) |
| Authentication | none needed in-process; the optional route call uses `CRON_SECRET` read inside the container |
| After a restart | the poller starts with the server; due work is read from the database |
| Overlap | per-process flag, plus the atomic per-enrollment claim across processes |
| Failure and retry | per-step backoff 10 min / 60 min, max 3 attempts, then `FAILED` |
| Duplicate prevention | claim lease + send-time re-check; see residual risk 1 |
| Monitoring | `readiness.sequenceScheduler`, logs, `SequenceStepLog` |

## 6. Hardening added in this change

- The poller no longer lets a **hung** run block a job forever: a run that has been going for more than 10 minutes is treated as stuck and a new run may start (the atomic claim keeps that safe).
- `revalidatePath` inside the sweep is wrapped, because the poller has no request context.

## 7. Test status

| Check | Result |
| --- | --- |
| Poller (both jobs, disable flag values, once-only start, edge runtime, failure isolation, overlap skip, stuck-run recovery) | PASSED |
| Drain backlog / no double processing (fake database) | PASSED |
| Claim lease, retry/backoff, permanent failure, unenroll race at dispatch | PASSED |
| Health `sequenceScheduler` category | PASSED |
| Anything against a real PostgreSQL (`INTEGRATION_DATABASE_URL`) | SKIPPED / NOT RUN - no database; the disposable-database guard was not weakened |
| Docker image / compose / systemd timer | NOT RUN |
| Live Gmail send | NOT RUN |
