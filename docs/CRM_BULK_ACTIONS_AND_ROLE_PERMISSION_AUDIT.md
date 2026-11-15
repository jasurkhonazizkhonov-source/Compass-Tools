# CRM Bulk Actions and Role Permission Audit

Date: 2026-11-15. Scope: Leads and Contacts checkbox selection and bulk actions in `compass-tools-updated`. **Result: already implemented and correct; verified by reading the code and running its tests; no change was needed to the bulk feature itself.** Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. What exists (verified in code)

| Piece | File |
| --- | --- |
| Selection helpers (page selection state, page toggle, limit 100, filter signature) | `src/lib/bulk-selection.ts` |
| Provider, row checkbox, header "select page" checkbox, action bar | `src/components/crm/bulk-selection.tsx` |
| "Add to sequence" dialog | `src/components/crm/bulk-enroll-dialog.tsx` |
| Server actions `bulkEnrollInSequence`, `bulkDeleteRecords` | `src/server/actions/bulk-selection.ts` |
| Role rules `canBulkEnrollInSequence`, `canBulkDeleteLeadsAndContacts` | `src/lib/permissions.ts` |

## 2. Requirement-by-requirement

| Requirement | Finding |
| --- | --- |
| A checkbox per record in Leads and Contacts | Present (both lists use `BulkRowCheckbox`). |
| Select all = **current page only** | `BulkSelectAllCheckbox` calls `toggleCurrentPage(selected, pageIds)`; the provider only ever receives the ids of the rows on the current page (the lists are server-rendered and paginated), so a click cannot select records beyond the page. Selection from other pages is kept, and deselecting only removes this page's rows. Tested for page sizes 25, 50 and 100. |
| Deselect all / counts | "Clear selection" button; the count uses the right noun (leads/contacts) and follows each change. |
| Pagination / page size | Selection survives page changes and page-size changes; a changed **search, status, agent or sort drops the selection** (the records on screen are no longer the ones selected) - clicking through pages of the same filter does not. |
| Limit | 100 records; the 101st is refused with a message, an over-limit select-all adds nothing; the server re-validates 1..100 and rejects other types. |
| Toolbar | Appears with a count; shows **Add to sequence** only when `canEnroll`, **Delete** only when `canDelete`. |
| Ordinary users may enroll but not delete | `canBulkEnrollInSequence` = may manage sequences (Admin, Manager, Travel Agent) **and** has the list; `canBulkDeleteLeadsAndContacts` = **Administrator only** (narrower than single-record delete, which Managers also have). Ticketing, Flight Expert and Marketing roles have neither. |
| Server-side enforcement (not just hidden buttons) | `bulkDeleteRecords` re-checks the role on the server, **records a `BULK_DELETE_DENIED` audit row** for a refused caller, and returns the error (production masks a thrown message). `bulkEnrollInSequence` re-checks the role, the sequence (visible to the caller, **active**, has a step) and every record against the caller's own visibility. |
| Company isolation | every lookup merges `leadVisibilityWhere` / `contactVisibilityWhere` / `sequenceVisibilityWhere`; another company's ids come back as "no longer available to you" and are never enrolled or deleted. |
| Deletion confirmation | a confirm dialog names the count and the consequences (for contacts: their leads, quotes and bookings go too); nothing happens until confirmed. |
| Deletion semantics | each record goes through the **existing** `deleteLead` / `deleteContact` (role + scope re-check, database cascade, stored-file cleanup, per-record audit entry) plus one summary audit row for the batch; failures are reported per record and the failed ones stay selected. |
| Contacts -> sequences | a contact is enrolled **through its most recent visible lead** (sequences are enrolled via leads); a contact with no accessible lead is reported, not silently skipped. |
| Duplicate / ineligible | already-active enrollments are reported as already enrolled; a record with no email, no assigned agent, or an unavailable Gmail is reported with that reason; the same id sent twice counts once. |

## 3. Interaction with this task's changes

- `bulkEnrollInSequence` still refuses an **inactive** sequence itself; `enrollLeads` now also refuses one (defence in depth), so a bulk request cannot slip an enrollment into a switched-off sequence.
- Bulk enrollment does **not** send step 1 inside the request. Step 1 (and every later step) is sent by the scheduler within a minute of being due (see `CRM_SEQUENCE_SCHEDULER_AND_EMAIL_RELIABILITY_AUDIT.md`). Previously the user then had to press "Process Due Steps"; that button is gone.
- The new per-user "edit phone and email" permission does **not** affect bulk actions (they do not edit those fields).

## 4. Role matrix

| Role | Select | Bulk add to sequence | Bulk delete |
| --- | --- | --- | --- |
| Administrator | Leads, Contacts | yes | **yes** |
| Manager | own + team's records | yes (own team's records and sequences) | **no** |
| Travel Agent | own records | yes (own records; own sequences only) | **no** |
| Ticketing Agent | no Leads/Contacts lists | no | no |
| Flight Expert | no Leads/Contacts lists | no | no |
| Marketing Agent | no | no | no |

## 5. Test status

| Suite | Result |
| --- | --- |
| `src/lib/__tests__/bulk-selection.test.ts` (8: page state, page-only select, no mutation, limit, role rules) | PASSED |
| `src/components/crm/__tests__/bulk-selection.test.tsx` (22: selection, page/size/filter behaviour, limit, delete and enroll dialogs) | PASSED |
| `src/server/actions/__integration__/bulk-selection.integration.test.ts` (21: ordinary user can enroll, cannot delete; Manager/Admin scopes; cross-company; contacts via leads; validation) | **SKIPPED** - needs a disposable PostgreSQL (`INTEGRATION_DATABASE_URL`) |
| Direct-call permission matrix against a real database | NOT RUN (same reason) |

## 6. Limits

The server-side role and scope rules are proven against the real database only by the skipped integration suite; the unit/UI suites prove the client behaviour and the pure rules.
