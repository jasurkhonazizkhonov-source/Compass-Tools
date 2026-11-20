# Sequence Delivery and Contact Permission - Migration Readiness

Date: 2026-11-20. Scope: `compass-tools-updated`. **No database migration was executed, no database was used or created, PostgreSQL was not installed, and the disposable-database guard was not touched.** Everything below is source-level review and proposal. Status words: IMPLEMENTED / PROPOSED (not applied) / BLOCKED / NOT RUN.

## 1. Sequence delivery: what exists today (verified in source)

### 1.1 Identity of an attempt

An enrollment is `SequenceEnrollment` (`sequenceId`, `leadId`, `status`, `currentStepIdx`, `nextSendAt`). The step being sent is `sequence.steps[currentStepIdx]`. An attempt is one `SequenceStepLog` row `(enrollmentId, stepId)`; a retry is another row for the same pair. There is **no attempt number, no unique key, no delivery-state column**; state is carried by the row `status` (SENT / FAILED) plus a text prefix in `error` (`IN_FLIGHT:`, `UNCERTAIN:`, `RETRY_EPOCH:`, `RESOLVED:`).

### 1.2 States and transitions (now also in code: `src/lib/sequence-delivery-state.ts`, IMPLEMENTED)

| State | Today's representation | Automatic transitions out | Human transitions out |
| --- | --- | --- | --- |
| (Pending) | no row for the step; enrollment ACTIVE with `nextSendAt` | -> SENDING (worker writes the marker) | - |
| SENDING | FAILED row, `error` = `IN_FLIGHT: ...` | -> SENT (Gmail accepted), -> FAILED (definite refusal), -> UNKNOWN (timeout/5xx, or abandoned: found again after the lease) | - |
| SENT | SENT row | none (terminal) | - |
| FAILED | FAILED row, plain error text | none (terminal; the retry is a NEW attempt on the same enrollment and step, up to 3 since the last restart) | "Retry now" / "Retry" starts a new attempt |
| UNKNOWN | FAILED row, `error` = `UNCERTAIN: ...` | none: **never resent automatically** | "It was sent" -> SENT; "Send again" -> SUPERSEDED then a new attempt |
| SUPERSEDED | FAILED row, `error` = `RESOLVED: ...` | none | - |
| (Cancelled) | enrollment UNSUBSCRIBED; no attempt row | - | Unenroll |

Invalid transitions are rejected in code (`assertTransition`, called in the sweep and in the resolution action; `sequence-delivery-state.test.ts` checks all 25 pairs). Valid: SENDING->{SENT,FAILED,UNKNOWN}, UNKNOWN->{SENT,SUPERSEDED}; SENT, FAILED, SUPERSEDED terminal.

### 1.3 Concurrency model (precise)

1. **Claim.** `UPDATE SequenceEnrollment SET nextSendAt = lease WHERE id = ? AND status = 'ACTIVE' AND nextSendAt = <value read>` (2-minute lease). In PostgreSQL under READ COMMITTED a second updater waits for the first to commit, re-evaluates the WHERE clause, matches no row and gets count 0. This **is** a database-level guarantee across processes, but it has been exercised here only against an in-memory fake (**NOT demonstrated on PostgreSQL**).
2. **Write-ahead marker** (plain insert, no uniqueness). It protects against an abandoned or slow earlier attempt: a later pickup that finds an unresolved marker holds the step. It does **not** by itself stop two workers from both passing the "no marker yet" read.
3. **Defect found and fixed in this task (see section 1.4):** after the claim, the pre-send "still eligible" update only checked `status = ACTIVE` and re-wrote the lease, so a worker that stalled for more than the lease (between claim and marker insert) could proceed after another worker had legitimately claimed the same row. It now verifies the lease is still its own.
4. **What the database provides today:** no unique index on `SequenceStepLog`; no unique index on `(sequenceId, leadId, ACTIVE)` for enrollments (the pair is serialized by `pg_advisory_xact_lock` in the enrollment transaction, also unverified on PostgreSQL). A uniqueness constraint alone would not fix everything: a crash after Gmail accepted a message and before any record is written leaves nothing for a constraint to see; that case is covered by the write-ahead marker + "unknown, human decides", not by a constraint.

### 1.4 Crash and ambiguity cases (answers to the 11 questions)

| Case | Result |
| --- | --- |
| Crash between marker and send | marker stays `IN_FLIGHT`; next pickup converts it to UNKNOWN and holds the step. A false UNKNOWN (nothing was sent) costs one human decision; chosen over a possible duplicate. |
| Gmail accepts, response unreadable | 2xx with unreadable body is SENT (`accepted-without-id`); a timeout/5xx is UNKNOWN. |
| Gmail accepts, DB write fails afterwards | marker stays `IN_FLIGHT` -> UNKNOWN. |
| Two workers, same step | row-level claim (fake-verified only) + lease-ownership re-check (new) + marker. |
| Process restart | all state is in the database; leases expire after 2 minutes; markers hold the step. |

Code change made for 1.3(3): in `src/server/due-sequence-steps.ts` the pre-send update is `WHERE id AND status = 'ACTIVE' AND nextSendAt = <my lease>` and extends the lease; a test steals the lease between claim and send and asserts nothing is sent.

## 2. Proposed typed persistence model (PROPOSED - not applied)

Smallest maintainable change: **formalize the existing step-log row**, no separate attempt table (a row already is an attempt).

```prisma
enum SequenceDeliveryState { SENDING SENT FAILED UNKNOWN SUPERSEDED }

model SequenceStepLog {
  // existing: id enrollmentId stepId status sentAt error createdAt
  deliveryState     SequenceDeliveryState?   // null only for legacy rows until backfilled; new rows always set it
  attemptNumber     Int                      @default(1)   // 1,2,3... per (enrollmentId, stepId)
  startedAt         DateTime?                // when the write-ahead row was written
  finishedAt        DateTime?                // when the outcome (or the unknown) was recorded
  errorCode         String?                  // NOT_CONNECTED | REAUTH_REQUIRED | RATE_LIMITED | PROVIDER | TIMEOUT | UNKNOWN_OUTCOME (no free text)
  providerMessageId String?                  // Gmail message id when accepted
  resolvedById      String?                  // account that resolved an UNKNOWN attempt
  resolvedAt        DateTime?
  resolution        String?                  // 'CONFIRMED_SENT' | 'SENT_AGAIN'
}
model SequenceEnrollment { attemptsResetAt DateTime? }  // replaces RETRY_EPOCH rows
```

Required by the typed model: transitions as in 1.2; timestamps `startedAt` on SENDING, `finishedAt` on every leaving transition; attempt id = `(enrollmentId, stepId, attemptNumber)`; retry semantics unchanged (3 confirmed failures since `attemptsResetAt`, backoff 10/60 minutes).

**Database-level protection (the part a constraint can genuinely do):** partial unique indexes, written in the migration SQL (Prisma cannot express them in `schema.prisma`):

```sql
-- at most ONE open attempt per step: the write-ahead insert becomes an atomic lock even if a lease expires or two workers race
CREATE UNIQUE INDEX "SequenceStepLog_one_open_attempt" ON "SequenceStepLog" ("enrollmentId","stepId") WHERE "deliveryState" IN ('SENDING','UNKNOWN');
-- at most ONE confirmed send per step
CREATE UNIQUE INDEX "SequenceStepLog_one_sent" ON "SequenceStepLog" ("enrollmentId","stepId") WHERE "deliveryState" = 'SENT';
```

With the first index, a second worker's `INSERT` of a SENDING row for the same step fails with a unique violation and that worker must not send: it closes the stalled-worker race even without the lease. It does **not** stop: a person choosing "Send again" (deliberate), Gmail processing one request twice, or a crash after acceptance (handled as UNKNOWN).

### Legacy data conversion (in the same migration, PROPOSED)

```sql
UPDATE "SequenceStepLog" SET "deliveryState" = CASE
  WHEN "status" = 'SENT'                         THEN 'SENT'
  WHEN "error" LIKE 'IN_FLIGHT:%'                THEN 'UNKNOWN'      -- anything still in flight at migration time is, by definition, abandoned
  WHEN "error" LIKE 'UNCERTAIN:%'                THEN 'UNKNOWN'
  WHEN "error" LIKE 'RESOLVED:%'                 THEN 'SUPERSEDED'
  WHEN "error" LIKE 'RETRY_EPOCH:%'              THEN NULL           -- not an attempt: moved to SequenceEnrollment.attemptsResetAt below
  ELSE 'FAILED' END WHERE "deliveryState" IS NULL;
UPDATE "SequenceEnrollment" e SET "attemptsResetAt" = m.t FROM (SELECT "enrollmentId", max("createdAt") t FROM "SequenceStepLog" WHERE "error" LIKE 'RETRY_EPOCH:%' GROUP BY 1) m WHERE e.id = m."enrollmentId";
DELETE FROM "SequenceStepLog" WHERE "error" LIKE 'RETRY_EPOCH:%';   -- only after the line above, in the same transaction
```

Legacy rows with no marker at all (older than the delivery work) are plain SENT / FAILED rows and convert directly. Pre-existing duplicate `SENT` rows for one step (possible before the marker design) would make the second index fail: a pre-check `SELECT enrollmentId, stepId, count(*) FROM "SequenceStepLog" WHERE "status"='SENT' GROUP BY 1,2 HAVING count(*)>1` must return no rows (or be reviewed) before applying.

### Safety, rollback, drift

- Additive columns (nullable or defaulted); the two `UPDATE`s and the `DELETE` touch only sequence-log bookkeeping; a verified backup is taken by `deploy.sh --migrate` first.
- `CREATE UNIQUE INDEX` (non-concurrent inside the migration transaction) takes a brief write lock on `SequenceStepLog`; the table is small relative to the others. A `CONCURRENTLY` variant cannot run inside Prisma's transaction.
- **Rollback is restore-from-backup**: Prisma migrations are forward-only; dropping the indexes/columns afterwards is possible by a new migration, but the converted markers (and the deleted RETRY_EPOCH rows) are not reconstructible without the backup.
- `deploy/check-migration-drift.sh` may report the partial indexes as unknown to the schema: **must be checked during the rehearsal**.
- Code ordering: `deploy.sh` migrates before starting the new image, and the migration is additive, so the old code keeps working until the new image starts. The typed-column code must not be deployed before the migration.

### Why it was not applied

No database is available, and adding the columns to `schema.prisma` without the migration applied would make every query against an un-migrated database fail. Decisions needed from the owner: (1) approve the model above, (2) approve a disposable PostgreSQL rehearsal (the pre-check, the conversion, the indexes, `prisma migrate status`, the drift script), (3) approve running it with `--migrate` later. Until then the production-safe implementation (text markers + `sequence-delivery-state.ts` guard + lease re-check) stays.

## 3. Contact-permission migration `20261115000100_account_contact_detail_edit_permission`

### 3.1 What it does

One statement: `ALTER TABLE "Account" ADD COLUMN "canEditContactDetails" BOOLEAN NOT NULL DEFAULT true`. It affects every `Account` row (filled with `true` by the same statement); no other column, row or table.

### 3.2 Assessment (source-level; `contact-permission-migration.test.ts`, 8 tests PASSED)

| Question | Finding |
| --- | --- |
| Still required? | Yes: the column is read by `getCurrentAccount` (full account row), `canEditContactDetails`, the eight contact phone/email actions, the Users toggle and the lead/contact pages. Without the column every authenticated request would fail once the new code runs. |
| Backward compatible? | Yes: additive, defaulted, no code path of the OLD release reads it. |
| Can it grant or remove permissions? | Default `true` preserves exactly today's ability: every user who could edit phone/email before still can; nobody gains the ability. It never touches `role`, `paymentPermissions`, `bookingPermissions` or sessions (asserted by a test). |
| Null / missing value | Not possible in the database (NOT NULL). In code a missing/`undefined`/`null` value is **denied** for non-admins (fails closed). |
| UI and server agree? | Both call `canEditContactDetails`; the server enforces in all eight actions; the UI only hides controls (tests `contact-detail-edit-permission*.test.ts`). |
| Can an Admin still manage it? | Yes; Admins are never restricted and the Admin toggle is refused for Admin targets. |
| Deploy ordering | `deploy.sh --migrate` takes a backup, migrates, then starts the new image: safe. Starting the new image on an un-migrated database would break every sign-in. |

### 3.3 Required steps (NOT performed)

Before: verified backup (`deploy/backup-db.sh`), `prisma migrate status` clean, rehearsal on a disposable PostgreSQL. After: `SELECT count(*) FROM "Account" WHERE "canEditContactDetails" IS NOT TRUE` = 0 for the default; Users page shows every non-admin as "Allowed"; a restricted test user cannot edit and the Admin can. Rollback: restore the backup (dropping the column afterwards is possible but loses switches an Admin set). **Ready for a future approved disposable-database rehearsal: yes. Executed: no.** Owner decision still open: default `true` (preserve) versus default-deny.

## 4. Explicit statements

- No migration was executed against any database; no Prisma migrate command was run.
- No PostgreSQL, Neon or Aiven was installed or configured; no database named `compass_test` was created or used.
- The 1,099 database-gated tests remain SKIPPED and are not counted as passed.
- Nothing in section 2 is claimed to be proven on PostgreSQL.
