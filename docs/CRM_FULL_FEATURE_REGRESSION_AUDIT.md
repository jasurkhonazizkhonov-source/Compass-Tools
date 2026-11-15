# CRM Full Feature Regression Audit

Date: 2026-11-15. Scope: `compass-tools-updated`. Method: automated checks over the whole tree plus a re-comparison with the unchanged original CRM. Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN. Skipped tests are **never** counted as passed.

## 1. Whole-tree results

| Check | Result |
| --- | --- |
| `tsc --noEmit` | PASSED (no errors) |
| `eslint .` | PASSED (no errors, no warnings) |
| `prisma validate` | PASSED |
| Vitest, full suite | PASSED: **4,320 passed, 0 failed**; **1,099 SKIPPED** (database-gated integration suites, 55 files) - skipped tests are not counted as passed |
| Standalone production build (`NEXT_OUTPUT=standalone npm run build`, dummy unreachable `DATABASE_URL`) | PASSED (compiled successfully; `.next/standalone/server.js` produced) |
| Standalone server boot (no database) | PASSED without a database: the built server starts, the poller starts and both sweeps run on the first tick and **fail safely** (`DatabaseNotReachable` logged as `[sequence-sender]` / `[task-notifier]`, no crash); `/api/cron/sequences` answers 401 without the bearer; pages that need the database return 500 (expected) |
| Docker image build / compose run | NOT RUN - Docker is not installed on this machine |
| PostgreSQL integration suites (`INTEGRATION_DATABASE_URL`) | SKIPPED - no PostgreSQL; the disposable-database guard was not weakened |
| Browser (Playwright / manual) against the running CRM | NOT RUN - no database to sign in against |

## 2. Features changed in this task, and what protects them

| Feature | Change | Regression evidence |
| --- | --- | --- |
| Global search (Ctrl+K) | dialog crash fixed; role-based groups; email/phone matching | `global-search.test.tsx` (7), `global-search.test.ts` (11) - PASSED |
| Lead IP reveal | Administrator only | `lead-submission.test.ts`, `permissions.test.ts` - PASSED |
| Lead/Contact phone & email permission | new column, 8 guarded actions, Users toggle, mass-assignment fix | 27 new + updated tests - PASSED; migration NOT applied anywhere |
| Sequence approve-and-start | new action + approval dialog | `sequences.test.ts`, `apply-sequence-dialog.test.tsx` - PASSED |
| Sequence scheduler | poller sends sequences; drain; health category; stuck-run recovery | `instrumentation-poller.test.ts`, health route tests - PASSED |
| Enrolled-leads table, progress | new component + helper | `sequence-enrollments-table.test.tsx`, `sequence-progress.test.ts` - PASSED |
| Enroll Leads: status filter in "Choose leads" | added | `enroll-leads-pick-filter.test.tsx` - PASSED |
| Salesboard date-range picker | now the shared modern calendar, range highlighted | `range-date-fields.test.tsx` - PASSED |
| Create Lead for an existing contact | no longer fails when the user lacks the phone/email permission (see section 4) | `leads.test.ts` (+2: restricted user can still create the lead; permitted user and Admin still get the extra details attached) - PASSED |

## 3. Features verified unchanged (code read + existing tests)

Bulk selection and bulk actions (Leads / Contacts), status-based sequence enrollment, unenroll, Commissions and Salesboard figures and the removed comparison text, pay-period resolution and time zones, inquiry idempotency, website API contract, IPv4/IPv6 capture and canonicalisation, Cloudflare/Vercel/nginx trusted-proxy handling (forged `X-Forwarded-For` / `True-Client-IP` ignored), approximate location with no coordinates, health endpoint minimal anonymous answer, cron authentication, security headers / CSP, body-size limits, card vault and CVV rules.

## 4. Regression found and fixed during this audit

Putting the permission guard on `addContactPhone` / `addContactEmail` exposed a hidden caller: **`createLead`** calls them to attach a phone or email, typed on the form, to an **existing** contact ("New Lead for Customer"). For a user without the new permission that call would have thrown and aborted the lead creation. Fixed: `createLead` now attaches the extra phone/email only when the creator holds the permission; otherwise the lead is created normally and the extra details are simply not added to the contact. (Creating a *new* contact is unaffected: a brand-new contact's first phone/email is part of creating it, not an edit of an existing one.)

## 5. Re-comparison with the original CRM

| Item | Result |
| --- | --- |
| Original CRM files vs the 2026-11-13 baseline (SHA-256, all files) | PASSED: 1,378 of 1,378 files identical, 0 differences |
| Original website vs baseline | PASSED: 1,122 of 1,122 files identical, 0 differences |
| Updated-only changes in this task | listed in the release report (files changed) |
| Original behaviours deliberately changed here (all documented) | global-search crash fix, Active/Inactive sequences, sequence auto-sending, lead-IP reveal Admin-only, phone/email permission, `updateContactField` whitelist |

## 6. Known gaps carried forward (not regressions)

No real-database verification; no Docker build; the website's Privacy Policy describes IP/location for flight requests only; lead "Reveal" for **booking** IPs still follows the separate booking-IP grant; sequence automation is verified only against a fake database and mocked mail; Quotes and Bookings lists have no search box (global search covers them).
