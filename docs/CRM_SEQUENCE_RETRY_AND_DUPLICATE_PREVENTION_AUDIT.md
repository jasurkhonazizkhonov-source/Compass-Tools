# CRM Sequence Retry and Duplicate Prevention Audit

Date: 2026-11-16. Scope: `compass-tools-updated`. Fake database, mocked Gmail; nothing was sent. Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN. **No exactly-once claim is made anywhere in this report.**

## 1. The risk carried over from the previous report

A send can succeed at Gmail while the CRM never learns it: a timeout or dropped connection after Gmail accepted the message, an unreadable success response, a crash before the log row was written, a database error right after. The old sweep then treated the step as failed (or left it claimed) and **sent it again** when the 2-minute claim lease expired.

## 2. What the code actually had (inspected)

| Mechanism | Finding |
| --- | --- |
| Enrollment idempotency | one ACTIVE enrollment per (sequence, lead): checked in `classifyLeadsForEnrollment`, re-checked inside the enrollment transaction under `pg_advisory_xact_lock` per pair. **Database behaviour not verifiable here** (fake DB only). No database unique constraint backs it. |
| Step-level idempotency | none: `SequenceStepLog` has no unique key; `EmailLog.messageId` is recorded after the send. |
| Provider identifiers | `messages.send` returns an id; the CRM only holds the **send** permission, so it cannot ask Gmail "was message X sent?" (no read scope). Message-ID reuse is not a reliable de-duplication in Gmail and is not relied upon. |
| Claim / locking | conditional `updateMany` on `nextSendAt` with a 2-minute lease before any side effect (tested against the fake only). |
| Network behaviour | `fetch` had **no timeout**; the `catch` turned every thrown error into a plain failure; and a 2xx response whose JSON could not be parsed was **reported as a failure although Gmail had accepted the message** - a direct duplicate path. |

## 3. What was implemented (no schema change)

### 3.1 Honest send results (`src/server/email/gmail-send.ts`)

- The request has a 30 s deadline (`GMAIL_SEND_TIMEOUT_MS`).
- A failure now carries `ambiguous: true` when the request may have reached Gmail: timeout/abort/dropped connection, or a 5xx. Definite answers (no request made, 401, 403, 429, other 4xx) are **not** ambiguous.
- A 2xx whose body cannot be read is a **success** (`messageId: "accepted-without-id"`), not a failure.

### 3.2 Write-ahead delivery record (`src/lib/sequence-delivery.ts`, `src/server/due-sequence-steps.ts`)

Delivery state of a step lives in its existing `SequenceStepLog` rows (status FAILED rows whose error starts with a marker; every existing reader keeps working):

| Marker | Meaning |
| --- | --- |
| `IN_FLIGHT:` | written **before** the Gmail request leaves; replaced by SENT (success) or an ordinary FAILED row (definite refusal) |
| `UNCERTAIN:` | outcome unknown: an in-flight marker that never resolved, a timeout, a 5xx. **Never resent automatically.** |
| `RETRY_EPOCH:` | a person restarted an enrollment that had given up; earlier failures stop counting toward the automatic limit |
| `RESOLVED:` | an unconfirmed delivery a person resolved with "Send again" |

Sweep order per claimed enrollment: claim lease -> read the step's rows -> **if an unresolved marker exists, hold** (`nextSendAt = null`, so no sweep selects it; activity `SEQUENCE_DELIVERY_UNCERTAIN`) -> render -> dispatch-time `ACTIVE` re-check -> **write IN_FLIGHT** -> send -> record. An `ambiguous` result becomes `UNCERTAIN` and holds the enrollment; a definite failure becomes a normal failed attempt with the existing retry rules. One enrollment throwing unexpectedly is caught and logged by category only and no longer stops the others; its in-flight marker makes the next pickup safe.

### 3.3 Recovery (`src/server/actions/sequences.ts`)

- `retryEnrollmentNow(enrollmentId, leadId?)`: restarts the **same** enrollment (ACTIVE with a pending retry, or FAILED). Access-checked like Unenroll; refuses while a delivery is unconfirmed; **verifies Gmail for real first** and returns the Gmail notification data if it is not usable; conditional updates so it cannot step on a worker that claimed the row; a FAILED restart writes `RETRY_EPOCH`.
- `resolveUncertainDelivery(enrollmentId, "sent" | "resend", leadId?)`: a person checks the sender's Gmail **Sent** folder. "It was sent" records the step as sent and advances; "Send again" verifies Gmail, marks the marker `RESOLVED`, and sends once more. Both are audited with who decided, and the UI warns that "Send again" may deliver two copies.

## 4. Duplicate-send matrix (task section 12)

| Cause | Protection | Evidence |
| --- | --- | --- |
| Double-click on Approve | button disabled while pending; second call returns `ALREADY_ENROLLED`; no second send | `apply-sequence-dialog.test.tsx`, `sequences.test.ts` "approving twice" - PASSED (fake DB) |
| Refreshing the lead | the lead page only reads; no action runs on load | by construction; no test needed beyond the above |
| Retried request after a dropped connection | same as double approval; a thrown action shows "result not known", refreshes | PASSED |
| Two workers on the same step | atomic claim | "two workers running at the same moment send the due step once" - PASSED (fake DB); real PostgreSQL **NOT RUN** |
| Overlapping scheduler ticks | per-process in-flight flag + 10 min stuck-run recovery + the claim | `instrumentation-poller.test.ts` - PASSED |
| Timeout after Gmail accepted | `ambiguous` -> `UNCERTAIN`, held, no auto-retry | "Gmail gives no answer..." - PASSED |
| Crash after the request left | `IN_FLIGHT` marker -> next pickup holds | "the process dies after the request left" - PASSED |
| DB error right after Gmail accepted | marker stays `IN_FLIGHT` -> held | "Gmail accepted the email but the CRM could not record it" - PASSED |
| Server restart | state is in the database; fresh code sends once and not again | "a restart loses nothing" - PASSED |
| Unreadable 2xx body | treated as success | `gmail-readiness-states.test.ts` - PASSED |

## 5. What this does NOT guarantee (limits)

1. **Not exactly-once.** A crash between "the marker row was written" and "the request actually left" produces a false `UNCERTAIN` (nothing was sent but a person must decide); the design chooses *possible silence over possible duplicate* for customer email.
2. The CRM **cannot verify** an unconfirmed send itself; a person must look at the sender's Sent folder. A person can still choose "Send again" and cause a duplicate knowingly.
3. Concurrent identical approvals are protected by the advisory lock, which exists only against PostgreSQL: **BLOCKED / NOT RUN**.
4. Retry state is a convention over existing rows (error-text markers), not a typed column.

## 6. Smallest safe schema improvement (NOT made, needs approval)

If a hard guarantee and clearer data are wanted: a migration that (a) adds `SENDING` and `UNCERTAIN` values to `StepLogStatus` (additive `ALTER TYPE ... ADD VALUE`), and (b) adds a partial unique index `CREATE UNIQUE INDEX ... ON "SequenceStepLog" ("enrollmentId", "stepId") WHERE "status" = 'SENT'` so the database itself refuses a second recorded send of a step. Plan: rehearse on a disposable PostgreSQL, apply with `deploy.sh --migrate` (backup first), then replace the text markers with the enum values behind the same helper module. Not run anywhere; no migration was added in this task.

## 7. Retry behaviour summary

| Failure | Automatic | Manual |
| --- | --- | --- |
| Temporary (rate limit, token service, Gmail refusal) | same step after 10 min, then 60 min, max 3 real failures since the last restart, then FAILED | "Retry now" (Gmail verified first) |
| Permanent (not connected, revoked, no email/agent) | none: enrollment FAILED at once | "Retry" restarts the same enrollment once the cause is fixed |
| Unknown outcome | none | "It was sent" / "Send again" |

## 8. Tests

| Suite | Result |
| --- | --- |
| `sequences.test.ts` - "delivery state machine" (6), "retry and resolution" (8), "Scenarios C and D" (3) | PASSED |
| `gmail-readiness-states.test.ts` - "sendViaGmail - what is known about the outcome" (6) | PASSED |
| Real PostgreSQL concurrency, real Gmail behaviour on timeout | NOT RUN / BLOCKED |
