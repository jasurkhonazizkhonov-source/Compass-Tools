# CRM Sequence Enrollment and Execution Verification

Date: 2026-11-13. Scope: updated CRM. All sequence tests use an in-memory fake Prisma and a mocked mail sender; **no email was sent, no Gmail account was contacted, no database was used.**

## 1. Model

- `Sequence` -> ordered `SequenceStep`s (`order`, `delayMinutes`, `subject`, `body`); `SequenceEnrollment` per (sequence, lead) with `status` in `ACTIVE | COMPLETED | UNSUBSCRIBED | FAILED`, `currentStepIdx`, `nextSendAt`, optional `recipientEmail`, `enrolledById`; `SequenceStepLog` per attempt.
- There is **no per-enrollment PAUSED status**: an individual enrollment can only be unenrolled (`UNSUBSCRIBED`), unsubscribed by the recipient, completed or failed. Per-enrollment pause/resume is **Not implemented** (original behaviour too). Pausing a whole *sequence* is done with its Active/Inactive switch - see the defect fixed in section 3a.

## 2. Enrollment (`enrollLeads`, `sequence-enrollment-eligibility.ts`, `sequence-status-enroll.ts`)

Verified by tests (`sequences.test.ts` 44 tests, `sequence-status-enroll.test.ts`, `bulk-selection` tests):

- Eligibility verdicts per lead: `enrolled`, `alreadyActive`, `missingEmail`, `noAssignedAgent`, `gmailUnavailable`, `inaccessible`, `skipped`. A lead the actor cannot see is "inaccessible" (a client-supplied id list is never trusted).
- Duplicates: only a genuinely ACTIVE enrollment blocks a new one (a COMPLETED/UNSUBSCRIBED/FAILED one does not); a per-(sequence, lead) advisory lock inside the transaction re-checks and prevents double enrollment under concurrency (lock is recorded by the fake; real locking is a database matter).
- Gmail is checked **before** enrolling: if the lead's sending agent has no usable Gmail the lead is *not* enrolled, a `SEQUENCE_ENROLL_FAILED` activity records why, and a retry is possible later. A failed enrollment can never look ACTIVE.
- First send: new rows start at step 0 with `nextSendAt = now + first step's delayMinutes` (new test; later steps' delays are not used for the first send) and carry the enrolling user.
- Batched: one `createMany` per chunk for enrollments and one for activities (no N-query loop); chunked transactions with explicit timeouts.
- Permissions: enrolling is allowed to non-Admin roles for leads they can see (same visibility rules as the lead lists); bulk delete stays Admin-only; Unenroll is permission-checked.
- Status-triggered enrollment (a lead reaching a status enrolls it) is covered by `sequence-status-enroll.test.ts`.

## 3. Execution (`runDueSequenceSteps`, `src/server/due-sequence-steps.ts`)

- Selects ACTIVE enrollments with `nextSendAt <= now`; each is **claimed** with a conditional update that moves `nextSendAt` forward by a lease (`CLAIM_LEASE_MS`) so two concurrent workers cannot both send; a crashed worker's row becomes due again after the lease. Tests prove a second concurrent run sends nothing.
- Dispatch-time re-check: sequence still active, enrollment still ACTIVE, step exists, recipient still valid, unsubscribed/unenrolled in flight stays UNSUBSCRIBED (a single-step sequence no longer flips to COMPLETED after an unenroll during the send).
- Step order and delay: after a send the index advances and `nextSendAt = now + next step's delay`; the last step completes the enrollment.
- Failures: up to `MAX_SEND_ATTEMPTS = 3` with backoff 10 min then 60 min; then `FAILED`; each attempt is logged; the first step is not advanced on failure.
- Sweep functions live outside any `"use server"` module (`due-sequence-steps.ts`, `due-task-notifications.ts`) and are reached from signed-in users only through role-checked wrappers (`due-work-authorization.test.ts`), so the public cannot trigger them.

## 3a. Defect found and fixed: the Active/Inactive switch did nothing to scheduled sends

`toggleSequenceActive` flips `Sequence.isActive`, and the Sequences pages show "Active"/"Inactive", but neither `runDueSequenceSteps` nor `enrollLeads` ever read the flag (only the enroll *pickers* filtered on it, `src/server/queries/sequences.ts`). Switching a sequence off therefore did not stop already-enrolled leads from receiving their next email, and the public server action `enrollLeads` would enroll into an inactive sequence if called directly. The original CRM has the same behaviour. Fix (small, behaviour-visible, owner may veto):

- `src/server/due-sequence-steps.ts`: the due query now includes `sequence: { isActive: true }`. An enrollment of an inactive sequence is left exactly as it is (ACTIVE, same step, same `nextSendAt`) and is sent as soon as the sequence is switched back on, so the switch now works as a sequence-level pause/resume.
- `src/server/actions/sequences.ts`: `enrollLeads` (and therefore status-based enrollment) refuses an inactive sequence up front with a plain error, before any lead or Gmail lookup.
- Tests (`sequences.test.ts`, 3 new): inactive = nothing sent and row untouched, then sent after re-activation; active sequences unaffected; enroll refused with nothing created.

## 4. Scheduler / poller

- `src/instrumentation.ts` starts an in-process 60-second poller **only for task-due notifications**. New test file `src/__tests__/instrumentation-poller.test.ts` (16 tests, fake timers) proves: default ON; `DISABLE_IN_PROCESS_POLLER` = `true`/`1`/`yes`/`on` (any case, trimmed) turns it off; any other value (`false`, `0`, `off`, `disabled`, empty) leaves it ON (an unknown value never silently disables work); registering twice starts one interval; the edge runtime starts nothing; a failing sweep is logged and the interval continues; the sequence sweep is never called by the poller.
- **Finding (pre-existing, needs an owner decision):** nothing in the VPS deployment calls `/api/cron/sequences` on a schedule (`deploy/run-daily-maintenance.sh` and compose do not), and the in-process poller does not run the sequence sweep. As deployed from this repository, **enrolled leads would never receive their steps** unless an external scheduler hits `GET /api/cron/sequences` with `Authorization: Bearer $CRON_SECRET` (e.g. every minute). The route itself and its auth are tested. This was true of the original; it was not changed because it needs a product/ops decision (add the call to the maintenance timer, or let the poller run it).

## 5. Status

| Item | Status |
| --- | --- |
| Eligibility, duplicate, scoping, permissions, Gmail pre-check | Verified working (mock-tested); concurrency lock **requires database verification** |
| Step order, delays, first-send delay | Verified working (mock-tested) |
| Retry/backoff, FAILED, unsubscribe in flight | Verified working (mock-tested) |
| Claim lease / no double send | Verified working against the fake; real row-level behaviour **requires database verification** |
| `DISABLE_IN_PROCESS_POLLER` | Verified working (new tests) |
| Real email delivery (Gmail API) | **Requires external service verification** |
| Pause / resume of one enrollment | **Not implemented** |
| Pause / resume of a whole sequence (Active/Inactive switch) | Defect fixed in this task (previously cosmetic); mock-tested |
| Business-hours / time-zone aware sending | **Not implemented** (delays are plain minutes) |
| Scheduling of the sequence sweep in the VPS deployment | **Defect/gap (pre-existing)**: not scheduled |
