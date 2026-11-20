# Failed Sign-ins, Customer Email Privacy, Subscriptions and Queued Campaign Delivery - Implementation and Audit Report

Date: 2026-11-20. Project: `compass-tools-updated`, branch `review/crm-verification-2026-11-13`. Status words: **VERIFIED** (by a test that was run and passed), **NOT VERIFIED** (written, not exercised against the real thing), **BLOCKED** (needs infrastructure that does not exist here), **DECISION** (needs the owner). The CRM is **not declared production-ready** by this document; section 10 lists what stands between this code and a controlled redeployment.

## 1. What was audited

The previous session reported the work below. In this session every claim was re-read in the source, and the application was searched for paths the previous session had not touched. Defects found and fixed during the audit are listed in section 9.

## 2. Failed sign-ins (Admin only)

| Aspect | Implementation |
| --- | --- |
| Who can see it | Administrators only, in four independent layers: `proxy.ts` route rule, the page (`notFound()` before any record is read), every server action (`assertAdmin`), and the sidebar item (a convenience). Tests: `proxy.test.ts`, `page-authorization.test.ts`, `failed-signins-capture-and-admin.test.ts`, `sidebar-failed-signins.test.tsx`. |
| What is recorded | One row per genuine authentication failure (Google token rejected, unknown account, disabled account, not-initialised, bootstrap-email mismatch). A successful sign-in and an ordinary server error after identity was verified record nothing. |
| Identity | `verifiedEmail` / `verifiedFullName` come only from the provider's verified answer. `attemptedEmail` is reserved for an unverifiable identifier and is never shown as verified. A name is never invented from an email. |
| Secrets | No credential, token or cookie is stored; only a 32-hex prefix of a hash (`attemptKey`) used to recognise a retried delivery of the same attempt for 60 s. |
| IP | The full IPv4 / canonical IPv6 address as seen by the trusted proxy path (`TRUSTED_PROXY`); forged `X-Forwarded-For` / `True-Client-IP` are ignored. Approximate location from the local DB-IP database; no coordinates are stored. |
| Flood control | More than 20 attempts per address in 10 minutes are folded into ONE `EVENTS_SUPPRESSED` roll-up row that carries the count (`x40`), so nothing is silently invisible and volume is bounded. |
| Time | Stored UTC; shown in the business time zone `America/Los_Angeles` (DST-safe day ranges; `business-time.test.ts`). |
| Retention / deletion | Kept until an Administrator deletes them (no automatic deletion). Deletion is by explicit id list (max 200), company-scoped, real removal of the personal data, with an audit entry holding only the actor and counts. Events with no company (identity unverifiable) are visible to and deletable by an Administrator of any company - a deliberate consequence of not being able to attribute them. |
| Caching / indexing | `force-dynamic`; `/failed-signins/:path*` now carries `Cache-Control: private, no-store` (added in this audit) and is in the crawler disallow list (robots.txt is a courtesy, not access control). |

## 3. Customer email privacy

**Policy** (`src/server/privacy/customer-email.ts`, the one place that decides): Administrators and users with *Unlimited Customer Email Access* see complete customer addresses; **every other role is masked by default** (`j********h@gmail.com`: first and last character of the local part and the domain are kept; short and malformed values fall back safely). The permission is read fresh from the database on every decision, so revoking it applies on the next request; an unreadable permission fails closed (masked).

**Reveal allowance.** A restricted user may reveal the complete addresses of 5 customers per business day (`America/Los_Angeles`). Implementation: one transaction that (1) inserts a unique `(user, contact, day)` reveal row `ON CONFLICT DO NOTHING` (a repeat reveal of the same customer is free and race-proof), (2) advances the per-user per-day counter with a single `INSERT .. ON CONFLICT DO UPDATE .. WHERE count < 5 RETURNING`, (3) rolls everything back when the counter refuses, and writes an audit entry (actor, contact id, method, day; **never the address**). A failed read rolls back without consuming allowance. The response of the Reveal action carries no address: the page is re-rendered by the server.

**Exposure map** (where an address could reach a restricted user, and what now happens):

| Path | Result |
| --- | --- |
| Lead / contact detail pages (info card, primary email, email list, activity timeline) | masked until revealed; reveal button + "n / 5 used today" |
| Leads / contacts lists, referral picker, task lead-picker, global search | masked; **search never matches on email text for a restricted viewer** (a partial match is an oracle that reconstructs the address) |
| Email composer (lead, contact), quote send picker, sequence enrollment picker, airline-confirmation dialog | recipients are named by opaque id; the server resolves the address; a **raw address from a restricted user is refused** (it would be a probe for "is this address on file?"); an id of another customer is refused; confirmations show masked addresses |
| Quotes page, booking page, signed booking details, New Lead dialog, duplicate-contact lookup | masked; New Lead for an existing customer no longer needs the address retyped, and a masked value echoed back is never stored |
| Sequence enrollments table (per-enrollment recipient) | masked |
| Lead offer modal (polled) | masked |
| Activity timeline "load more" action and the dashboard activity feed | **masked (added in this audit; both leaked)** |
| Direct calls to server actions | the same checks run server-side; UI hiding is never the control |
| Logs / errors | only error categories are logged; no address in any new log line |
| **Staff notification emails** ("New Flight Request", lead/contact reassignment, new-sale notice) | **DECISION**: these deliberately carry the complete customer address (and a mailto Reply button) to the recipient's own mailbox, which bypasses the reveal allowance. Masking them would change a business workflow, so it was not changed. Options: keep, mask for restricted recipients, or omit the address and link to the lead. |
| Bulk contact import duplicate report | echoes only addresses the user typed; reveals nothing new |
| Get in Touch / CRM inquiries | Administrator only already |
| Subscriber lists | Administrator and Marketing Agent (existing business rule, unchanged). These are marketing audiences, not CRM customer records; the page does not read Contacts/Leads. |

**Not covered / limits.** Free-text notes that an agent typed an address into are user content and are not rewritten. The EmailLog `toEmail` column holds complete addresses (no UI reads it for restricted users today). Masking is applied where the data is shaped for the browser; a future page that selects `primaryEmail` and passes it to a client component must go through `withEmailPrivacy` / `buildContactEmailView`.

**Admin toggle.** `Users` page column "Unlimited Customer Email Access", default OFF, Administrators show a fixed "Always". Server action `updateUnlimitedCustomerEmailAccess`: Administrator only, same company only, refused for an Administrator target, enabling needs the recent-sign-in step-up (disabling never does), audited without customer data.

## 4. Subscriber import (background job)

Parsing (`src/lib/subscriber-import.ts`): `email[,first[,last]]`, comma/semicolon/tab, optional header, quotes, BOM, CRLF; strict address validation; first of a duplicate wins; names stripped of control characters and markup and capped. **Limits: 250,000 rows and 4 MB per import** (4 MB because a list reaches the server as one Server Action body and `next.config.ts` caps those at 5 MB; this was 12 MB in the first draft, which the framework would have rejected with an opaque error - fixed in this audit). 4 MB is roughly 150,000 ordinary addresses, so a 250,000-row file only fits if rows are very short. **A 250,000-row import capacity is not a 250,000-email sending capacity** (section 7).

The request only validates and queues. The worker (`subscriber-import-worker.ts`, run every minute) processes 1,000 rows per chunk with a cursor (`nextRow`): it creates only addresses with no subscriber row (`createMany skipDuplicates` against `@@unique(companyId, email)`), **never modifies an existing SUBSCRIBED / UNSUBSCRIBED / SUPPRESSED subscriber**, counts them instead, and advances counters with a compare-and-swap on the cursor so two workers cannot count a chunk twice. A failed chunk marks the job FAILED while keeping its payload and cursor; Resume continues. The error report is `row,reason` lines (fixed codes, no address, no name) - there is no formula-injection surface. Verified with an in-memory database (100,000 rows in 20 ticks; restart; double processing; failure; CAS); **not verified on PostgreSQL**.

## 5. Campaign builder

Blocks: heading, text, image, button, divider, spacer. Buttons, linked images and image sources accept only absolute `http(s)` URLs with a host and no credentials, no control or quote characters (javascript:, data:, vbscript:, file:, mailto:, relative and protocol-relative links are refused; 21 hostile inputs are tested). Author text is HTML-escaped; personalization (`{{firstName|there}}`, lastName, fullName, email) escapes the recipient's data and uses the fallback when empty; unknown fields and unfilled `[[placeholders]]` block queueing. The server re-validates on save, renders table-based inline-styled HTML, and runs it through the existing sanitizer; the preview is rendered by the server with the same shell, sanitizer and personalization the send uses, in a sandboxed iframe with a restrictive CSP. The shell adds the company footer and the unsubscribe link, which a design cannot remove. Drafts and every action are Administrator / Marketing Agent only and company-scoped. A test send goes to the signed-in user's own address with sample data and is independent of the subscriber list.

## 6. Queued campaign delivery

`DRAFT -> QUEUED | SCHEDULED -> SENDING -> SENT`, with `PAUSED` and `CANCELLED`. Queueing sends nothing. The worker (`campaign-worker.ts`, once a minute):

- Fixes the audience in keyset chunks of 1,000 into `MarketingCampaignSend` (unique `(campaignId, subscriberId)`; `skipDuplicates`).
- **Write-ahead claim**: PENDING -> UNKNOWN by compare-and-swap before the message leaves; a crash afterwards leaves UNKNOWN, which is never sent again automatically (shown as "Outcome unknown").
- Re-reads the **campaign status and the subscriber's current status before every recipient** (pause, cancel, unsubscribe and suppression take effect inside a running batch - added in this audit).
- Failure handling: a Gmail timeout or 5xx is ambiguous -> UNKNOWN; a definite failure retries after 5 min, then 30 min, up to 3 attempts, then FAILED; a provider rate-limit answer backs the row off for an hour and stops the batch without counting a failure; a disconnected sender pauses the whole campaign without marking anything failed.
- Limits: `CAMPAIGN_SENDS_PER_MINUTE` (default 20) and `CAMPAIGN_DAILY_LIMIT` (default 400, rolling 24 hours per sending account). Both are computed **from the database**, so instances sharing a database share them; the per-minute budget was per process in the first draft and is global now (it counts recent attempts, including in-flight ones). The count and the claims are separate statements, so two instances ticking in the same instant can overshoot by at most one batch.
- Statistics: waiting / sent / failed / outcome unknown / skipped. **"Sent" means accepted by Gmail.** Opens, clicks, bounces and inbox placement are not tracked; the panel says so.
- Scheduling: the time is entered in the browser's zone (now labelled) and stored as an exact UTC instant; the worker promotes SCHEDULED campaigns whose time has passed.

Verified with an in-memory database and a fake provider (33 tests: budgets, rolling cap, suppression at send time, unsubscribed mid-batch, retries, ambiguous outcomes, crash recovery, rate limit, disconnected sender, schedule, pause, concurrency, 3,000-subscriber run, shared budget). **Not verified on PostgreSQL and not verified against real Gmail.**

## 7. Provider capacity (facts, not promises)

Sending uses the campaign author's own connected Gmail through the Gmail API. Gmail allows a few hundred messages a day for a standard account (the exact limit depends on the account type and Google's policies, which change). At the default 400/day a 10,000-subscriber campaign takes about 25 days; **a list of hundreds of thousands cannot be sent through Gmail** and needs a transactional / bulk email provider (new vendor, new cost, new DNS/authentication work). That is a **DECISION** and an approval item; nothing was changed or selected.

## 8. Database and API changes

One additive migration, `20261120000100_security_privacy_marketing_scale` (generated offline from the schema; **not applied to any database**): new tables `FailedSignInEvent`, `CustomerEmailRevealEvent`, `CustomerEmailRevealUsage`, `SubscriberImportJob`, `CampaignTemplate`; new nullable/defaulted columns (`Account.unlimitedCustomerEmailAccess` default false; subscriber suppression fields; campaign design, scheduling, cursor and send-row retry columns); new enum values (`SUPPRESSED`, `QUEUED`, `PAUSED`, `CANCELLED`, ...); indexes. No existing column, row or constraint changes. New server actions: failed-sign-in inspect/delete; reveal; unlimited-access toggle; import preview/create/list/cancel/resume/report; campaign save/preview/test/queue/pause/resume/cancel/analytics. No new public API route. New background jobs: `subscriber-imports` and `campaigns` in the existing in-process poller.

New environment variables (optional, with defaults): `CAMPAIGN_SENDS_PER_MINUTE` (20), `CAMPAIGN_DAILY_LIMIT` (400). `BUSINESS_TIMEZONE` is fixed in code to `America/Los_Angeles`.

## 9. Defects found and fixed by this audit

1. Customer addresses leaked through `loadMoreActivities` (a directly callable action) and the dashboard activity feed - now masked for restricted viewers.
2. The import size limit (12 MB) exceeded the Server Action body cap (5 MB) - now 4 MB with an honest message.
3. The campaign per-minute limit was per process - now shared through the database.
4. Pause / cancel / unsubscribe were only checked per pass, not per recipient - now per recipient.
5. Sequence post-send writes were not conditional on the step the worker had read, so a stale worker could overwrite a newer state - now conditional.
6. The poller logged the full error object (could carry a connection string or recipient) - now a category only; an in-flight sweep stops taking new work once shutdown is requested.
7. `/failed-signins`, `/leads`, `/quotes`, `/subscriptions` were not in the explicit no-store header list - added.
8. The schedule input did not say which time zone it used - now shown.
9. A test that depended on the time of day (24-hour window) was made independent of it.

## 10. Verification status and what blocks a controlled redeployment

See the final section of `COMPASS_SEQUENCE_WORKFLOW_RELEASE_READINESS.md` for the exact commands and numbers of the last run. Blockers / approvals: (a) **BLOCKED** - PostgreSQL verification of the migration, the reveal SQL, the claim/CAS statements and concurrency (no approved disposable database exists; the integration tests are written and skip); (b) **NOT VERIFIED** - real Gmail behaviour (OAuth, quota, ambiguous outcomes); (c) **DECISION** - staff notification emails carrying the full address; Marketing Agent visibility of subscriber lists; a bulk email provider before any large campaign; the 400/day and 20/min defaults; subscriber search by email (not built: it would conflict with "select all matching" bulk delete, which deletes by status only); (d) legal/privacy review of marketing consent, retention of failed sign-in records (IP addresses and names are personal data) and the reveal policy is the owner's and a professional's call - nothing here is a legal conclusion; (e) a browser pass of the new screens (section 11 of the readiness document records whether it was done).
