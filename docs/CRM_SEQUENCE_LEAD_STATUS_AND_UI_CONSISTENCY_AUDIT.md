# CRM Sequence Lead Status and UI Consistency Audit

Date: 2026-11-16. Scope: `compass-tools-updated`. jsdom/React Testing Library with mocked server actions and fake data; no browser, no database. Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. Source of truth

**Stored facts** (existing model, no schema change): `SequenceEnrollment.status` (`ACTIVE | COMPLETED | UNSUBSCRIBED | FAILED`), `currentStepIdx`, `nextSendAt`, and the per-step `SequenceStepLog` rows (SENT / FAILED, plus the delivery markers described in the retry audit). **One function turns them into the displayed state**: `deriveEnrollmentState` in `src/lib/sequence-progress.ts`, used by the lead page (`active-sequences.tsx`, `lead-sequences-panel.tsx`) and the sequence page (`sequence-enrollments-table.tsx`). Step chips use `computeStepProgress` from the same file.

## 2. The ten states the task lists, and how each is represented

| Task state | Representation |
| --- | --- |
| 1. Not enrolled | **no row exists** (a Gmail-blocked attempt creates nothing) |
| 2. Enrollment pending | not a stored state: enrollment and its first-send attempt happen in one server action; the dialog shows "Checking Gmail..." / a disabled Approve while it runs |
| 3. Active enrollment | `active` ("Active") |
| 4. First email pending | `first_email_pending` ("First email pending") - active, nothing sent yet |
| 5. Sending | `sending` - a recent write-ahead marker exists |
| 6. First email sent successfully | `active` with a SENT log for step 1; "Last sent: step 1 (time)" |
| 7. Temporarily failed and retryable | `retry_scheduled` ("Retry scheduled") with the last reason and the retry time, plus **Retry now**; also `unconfirmed` ("Delivery unconfirmed") with **It was sent / Send again** |
| 8. Paused | `paused` (active enrollment of a switched-off sequence; no send time promised) |
| 9. Unenrolled | `unenrolled` |
| 10. Completed | `completed` |
| (given up) | `failed` ("Failed") with the reason and **Retry** |

## 3. Behaviour verified in the UI tests

- **Same status on both pages** for all eight reachable states (`lead-and-sequence-consistency.test.tsx`, parametrized): first email pending, active, retry scheduled, delivery unconfirmed, paused, failed, unenrolled, completed - the badge text is identical on the lead card and the sequence row.
- **A failed attempt never looks like a successful active enrollment**: a FAILED enrollment is not rendered in the "Active sequence" notice at all; it appears in the lead's history labelled Failed with the real reason and "no further emails will be sent unless it is retried". An ACTIVE enrollment whose last attempt failed says "The last attempt failed: ... It will be retried automatically at <time>" and shows "Nothing sent yet" - it is not presented as healthy.
- **No false "sent"**: "Last sent" and the step chips come from the send log only (or from the step counter having advanced, which only happens after a recorded success).
- **Lead notification content**: sequence name (link), enrollment date/time and who enrolled, status badge, current step ("Step 2 of 3"), last sent step with time, next email date/time (omitted when paused or unconfirmed), one Unenroll button, recovery buttons by state.
- **Sequence table content**: lead, email (withheld as "Hidden" for a lead the viewer may not see), enrolled, status, "n of m sent" with per-step chips (Sent, Scheduled, Pending, Failed (retrying), Cancelled, Paused, Sending, Unconfirmed), last sent, next step, actions. Unenroll works from the table with the same button, confirmation and server action as the lead page; unenrolled rows stay as history.
- **Gmail-not-connected notification** inside the Lead's Apply Sequence dialog (title, whose Gmail, "No emails have been sent and this lead has not been enrolled", Connect/Reconnect Gmail when the viewer is the sender, Check again for a temporary problem). Returning after connecting: see the Gmail audit.
- **Process Due Steps absent**: static check over the sequence and lead UI sources (see the automatic-sending report).
- **Recovery actions by state**: Retry scheduled -> "Retry now"; Failed -> "Retry"; Delivery unconfirmed -> "It was sent", "Send again" (confirmation warns about two copies); no recovery buttons for Active, First email pending, Completed, Unenrolled; hidden entirely from a viewer who may not manage sequences. A retry that finds Gmail unusable shows the Gmail notification and claims nothing.

## 4. Data flow that keeps the pages consistent

The lead query (`src/server/queries/leads.ts`) now includes each enrollment's `stepLogs`; the sequence query already did. After any action both pages are revalidated (`revalidatePath` for `/leads/<id>` and `/sequences/<id>`) and the client calls `router.refresh()`. Stale client state therefore cannot outlive an action; between actions the pages render the same database rows through the same function.

## 5. Files

New: `src/components/sequences/enrollment-recovery-actions.tsx`, `src/components/sequences/gmail-problem-notice.tsx`, `src/lib/sequence-delivery.ts`. Changed: `src/lib/sequence-progress.ts` (`deriveEnrollmentState`, `sending` / `uncertain` step states), `src/components/leads/active-sequences.tsx`, `src/components/leads/lead-sequences-panel.tsx`, `src/components/sequences/sequence-enrollments-table.tsx`, `src/server/queries/leads.ts`.

## 6. Tests

| Suite | Result |
| --- | --- |
| `src/components/sequences/__tests__/lead-and-sequence-consistency.test.tsx` (25) | PASSED |
| `src/lib/__tests__/enrollment-state.test.ts` (15) | PASSED |
| `src/lib/__tests__/sequence-progress.test.ts` (8), `sequence-enrollments-table.test.tsx` (9), `active-sequences.test.tsx` and the rest of `src/components/leads` | PASSED |
| Visual check in a browser (desktop and phone), live data | NOT RUN - the signed-in pages need a database |

## 7. Limitations

The "Sending" state is shown only while the marker is under 3 minutes old and the page happens to be rendered in that window (the page does not poll). The state `enrollment pending` is not stored. Nothing here is verified against a real database or in a real browser.
