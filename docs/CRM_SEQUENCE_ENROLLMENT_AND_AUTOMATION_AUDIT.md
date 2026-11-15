# CRM Sequence Enrollment and Automation Audit

Date: 2026-11-15. Scope: `compass-tools-updated` only. All checks use a fake in-memory database and a mocked mail provider: **no email was sent, no Gmail account was contacted, no database was used.** Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. Previous state (verified in code before changing anything)

| Area | What was there |
| --- | --- |
| Enrolling one lead | `ApplySequenceDialog` -> `enrollLeads()` created an `ACTIVE` enrollment with `nextSendAt = now + step 1 delay`. **Nothing was sent.** |
| Sending | Only `runDueSequenceSteps()` sent anything, reached by a **"Process Due Steps" button** on the sequence page (and by `/api/cron/sequences`, which nothing scheduled). So the user had to enroll and then separately process. |
| Lead page | Already showed an "Active sequence" notice with step, next email time and an **Unenroll** button (confirm dialog, history kept). |
| Sequence page | A small list per enrollment: name, status badge, "Step n of m", next time, up to three Sent/Failed badges. No table, no email, no per-step progress, no unenroll. |
| Status-based enrollment | Existing and sound: "By status" mode (multi-select over the CRM's own `LeadStatus` values, server query `status IN (...)`, visibility-scoped, live preview with eligible / excluded counts, confirmation, per-reason result). "Choose leads" mode had **no status filter**. |
| Active/Inactive switch | Cosmetic (fixed in the previous task: the sweep now skips inactive sequences). |

## 2. What was changed

### 2.1 One approved action (root cause: enroll and send were two separate operations)

- **New server action `startSequenceForLead(sequenceId, leadId, recipientEmail?)`** (`src/server/actions/sequences.ts`). It calls the unchanged `enrollLeads()` (so authorization, company scoping, **active-sequence check**, Gmail pre-check, valid recipient, one ACTIVE enrollment per lead and sequence, unsubscribe/suppression behaviour all still apply) and then, **only when step 1 is due now**, sends it immediately through the same claim-and-send code the scheduler uses (`runDueSequenceSteps({ enrollmentIds })`). A step 1 with a delay is left to the scheduler and reported as "scheduled for <time>".
- **Honest results** (`StartSequenceResult`): `sent`, `scheduled`, `retrying` (temporary provider failure; retry time returned), or a refusal with a code (`ALREADY_ENROLLED`, `NOT_ELIGIBLE`, `SEQUENCE_INACTIVE`, `SEND_FAILED`, `ERROR`). A permanent first-send failure (Gmail not connected / authorization expired) leaves the enrollment `FAILED` and **visible in the lead's history**, and is returned as a failure, never as success.
- **Approval prompt** (`apply-sequence-dialog.tsx`): choose the sequence -> *Continue* -> a confirmation that states what will happen (first email "right away"/"in 2 hours" to which address(es); later steps automatic; unenroll any time) with **Approve and start** / **Cancel**. Cancel enrolls and sends nothing. The Approve button is disabled while the request runs (a double click cannot call the action twice). A refusal stays in the dialog with the reason; a thrown action (session expired, connection dropped) says the result is not known and refreshes the lead instead of claiming success.
- **No more "Process Due Steps" button.** Removed from the sequence page. The wrapper action `processDueSequenceSteps` (role-checked) still exists for maintenance; nothing in the UI uses it. (The unused component file `process-due-button.tsx` was left in place.)
- **Duplicate-send protection**: a repeated approval returns `ALREADY_ENROLLED` and sends nothing (existing dedupe + per-(sequence, lead) advisory lock inside the enrollment transaction); the send itself is claimed atomically exactly like a scheduled run.

### 2.2 Lead page notice

The active card now also shows the **enrollment date and time**, who enrolled, the current step ("Step 2 of 5"), the next email time, and - when the sequence is switched off - a plain note that no further emails are being sent (and the next-email time is not promised). Unenroll unchanged.

### 2.3 Enrolled-leads view inside a sequence

`SequenceEnrollmentsTable` (new) replaces the card list: **Lead, Email, Enrolled, Status, Progress, Last sent, Next step, Unenroll**. Progress is computed by the new pure helper `src/lib/sequence-progress.ts` from the stored enrollment and the per-step send log - a step is **Sent** only when a SENT log exists (or the counter has advanced past it, which only happens after a successful send); **Scheduled**, **Pending**, **Failed (retrying)**, **Cancelled** (unenrolled) and **Paused** (sequence switched off) are distinguished. "Skipped" is not shown because the model has no way to skip a step. The Email column is shown only for leads the viewer may see (a new visibility query); otherwise "Hidden". Unenroll reuses the same button/confirm/server action as the lead page; unenrolled rows stay as history, with the steps that did go out still shown as sent.

### 2.4 Enrolling by status

The existing "By status" flow was verified, not rewritten. Added to "Choose leads": a **status filter (any of the ticked statuses)**, a live "N shown - M selected" count and **Select all shown / Deselect all shown**, so a user can narrow by status and then pick the intended leads. Enrollment still goes through `enrollLeads` (already-enrolled leads are excluded and reported; missing-email / no-agent / Gmail problems are reported per reason).

## 3. Files changed or added (this part)

`src/server/actions/sequences.ts`, `src/server/due-sequence-steps.ts` (`enrollmentIds` option, `drainDueSequenceSteps`), `src/server/queries/sequences.ts`, `src/components/sequences/apply-sequence-dialog.tsx`, `src/components/sequences/sequence-enrollments-table.tsx` (new), `src/components/sequences/enroll-leads-dialog.tsx`, `src/components/leads/active-sequences.tsx`, `src/components/leads/lead-sequences-panel.tsx`, `src/app/(crm)/sequences/[id]/page.tsx`, `src/lib/sequence-progress.ts` (new). Tests: `sequences.test.ts` (+12 this task), `apply-sequence-dialog.test.tsx` (9, new), `sequence-enrollments-table.test.tsx` (9, new), `enroll-leads-pick-filter.test.tsx` (3, new), `sequence-progress.test.ts` (8, new).

## 4. Verified without changes

Gmail pre-check before enrolling; per-step retry/backoff (10 min, 60 min, max 3 attempts); permanent failures end the enrollment; unsubscribe link and `UNSUBSCRIBED`; company/visibility scoping; recipient validation against the contact's own emails; status filter `IN` semantics and server-side re-query at confirmation.

## 5. Test status (focused)

| Suite | Result |
| --- | --- |
| `sequences.test.ts` (59: approval, immediate/scheduled/retrying/failed first send, double approval, inactive, ineligible, unenroll race at dispatch, 120-enrollment backlog drain) | PASSED |
| `apply-sequence-dialog`, `sequence-enrollments-table`, `enroll-leads-*`, `sequence-progress` | PASSED |
| Concurrent approvals / concurrent workers against a **real PostgreSQL** (advisory lock, conditional-update claim) | NOT RUN - no PostgreSQL available; behaviour is verified only against the in-memory fake (see the scheduler audit) |
| Real email delivery through Gmail | NOT RUN |
| In a browser against a running app | NOT RUN - no database, so the signed-in UI cannot be loaded |

## 6. Remaining limits

- A bulk enrollment (many leads) does not send step 1 inside the request; the scheduler sends it within a minute.
- Pausing a single enrollment, business-hours sending and time-zone aware scheduling are **not implemented** (delays are plain minutes; unchanged).
- Unenrolling while an email is already being handed to Gmail cannot recall that email (see the scheduler audit).
