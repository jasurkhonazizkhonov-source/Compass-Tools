# Compass-Tools — feature, workflow and API compatibility audit (original vs updated)

Date: 2026-11-13. Read-only; static analysis, unit tests and local mocks only. Nothing was sent to production and no database was used. Companion reports: `ORIGINAL_VS_UPDATED_STRUCTURAL_PARITY_AUDIT.md` (structure, Git state, latest changes) and `CRM_DATABASE_AND_DEPLOYMENT_COMPATIBILITY_AUDIT.md`.

Decision for this report — **Functional compatibility: READY WITH CONDITIONS** (section 7).

Classification key (as required): Preserved · Intentional improvement · Intentional replacement · Intentional removal · Potential regression · Confirmed regression · Unverified.

## 1. Evidence base and its limits

* **Static**: route inventory, handler method lists, per-handler diffs, export parity (435 of 435 source files present, 0 exports removed).
* **Executable, no database**: the complete Vitest suite, run twice — 4,003 passed, 562 skipped; `tsc`, `eslint`, `prisma validate` clean; production standalone build passes.
* **Not available**: PostgreSQL (deferred by decision). Every statement below that depends on database behaviour is labelled **Unverified**; mocked results are not treated as database proof.
* **Compatibility is judged on contracts** (paths, methods, authentication, request fields, status codes, response fields), not on how similar the implementation is.

## 2. Pages, workflows and features

All 63 routes exist in both projects; `src/proxy.ts` (session check, role guards for `/dashboard`, `/contacts`, `/leads`, `/quotes`, `/sequences`, `/tasks`, `/bookings`, `/get-in-touch`, `/crm-inquiries`, `/system-health`, `/subscriptions`, `/commissions`, `/salesboard`) is byte-identical after normalisation. The only permission-module change is two added predicates.

| Area | Original behaviour | Updated | Classification |
| --- | --- | --- | --- |
| Login / Google sign-in / sessions | single active device, 24 h, step-up for privileged actions | same code; additionally records the sign-in location provenance (2 nullable columns) | Preserved + Intentional improvement (raw `UPDATE` now writes the two new columns → needs the migration, see database report) |
| Dashboard, Contacts, Companies/Accounts, Quotes, Bookings, Tasks, Users, System Health, Reports | present | present, source unchanged except the files below | Preserved |
| Leads and Contacts lists | single-row actions | + checkbox selection, "Add to sequence" (existing `canManageSequences` rule), Admin-only bulk delete re-checked on the server | Intentional improvement |
| Lead profile | tabs incl. Sequences | + "Active sequence" notice and Unenroll (server-side authorisation, ACTIVE-only, audit) | Intentional improvement |
| Sequences | enrol, worker, "Process Due Steps" | failed enrollment never ACTIVE, Gmail preflight, bounded retry, dispatch-time re-check, unenroll, enrol by status; the sweep moved to `due-sequence-steps.ts`, the button calls a role-checked wrapper | Intentional improvement / replacement — **DB concurrency Unverified** |
| Tasks | cron + in-process poller + "Process Due Tasks" | same; sweep moved to `due-task-notifications.ts`; poller **still ON by default**, new opt-out `DISABLE_IN_PROCESS_POLLER` | Preserved + Intentional improvement |
| Commissions / Salesboard | previous-period percentage comparison | comparison removed; calendar popover | Intentional removal (documented in `docs/UPDATED_PROJECT.md`) |
| Get In Touch / CRM Inquiries inboxes | two separate Admin-only inboxes | same, separate; each detail shows Admin-only masked IP and approximate location with audited Reveal (15-minute step-up) | Intentional improvement |
| Marketing campaigns / newsletter | HTML stored and sent as typed | HTML cleaned by an allow-list sanitiser at save, preview and send; preview is served by an Admin/Marketing-only action | Intentional improvement — **Potential regression** for stored HTML that depends on stripped markup (`<style>` blocks, `position`, forms, iframes, event handlers, `javascript:` links); the shipped starters are tested to survive |
| Email (Gmail), unsubscribe pages | present | present; `unsubscribe` POST now reads a bounded body | Preserved |
| File uploads | local-VPS storage (R2 already removed in the staged merge) | unchanged | Preserved |
| Reference data (airports/airlines) | seeded, self-healing | unchanged; new integrity test | Preserved |
| Search, filters, pagination | present | unchanged | Preserved |

No workflow present in the original was found missing. **Confirmed regressions: none.**

## 3. Route-by-route API contract comparison

Only the 16 route handlers are HTTP APIs; methods are identical in every file. "Unchanged" means no byte of the handler changed (it may still call shared code that changed).

| Endpoint | Auth | What changed | Request/response contract | Classification |
| --- | --- | --- | --- | --- |
| `POST /api/public/crm-inquiry` (CRM Inquiries) | none (rate-limited, honeypot, duplicate window) | handler file unchanged; shared `public-inquiry.ts` now (a) reads a bounded body, (b) records IP/location in the same insert, (c) supports an opt-in submission key | request fields unchanged; **new: a body over 64 KB → HTTP 413** `{ ok:false, error }` (previously buffered without limit); response `{ ok:true, id }` unchanged | Preserved + Intentional improvement |
| `POST /api/public/contact-inquiry` (Business Flights "Get In Touch") | none | `serverToServer: true` (the caller is the website's server, so the connection is never used as the visitor's IP; only a verified signed visitor context may supply one) and `acceptSubmissionId: true` | **new optional request field `submissionId`** (`[A-Za-z0-9._-]{8,200}`); response unchanged for first submissions, **adds `duplicate: true` only on a repeat** of the same key and content; same key with different content or e-mail → **HTTP 409**; 413 above 64 KB. A caller that never sends the key behaves exactly as before (stored on every call, no content de-duplication). | Preserved (additive) |
| `POST /api/public/lead-capture` (legacy website lead) | none | bounded body; local geolocation fallback for the stored IP's location | fields unchanged; 413 above 64 KB; 400 on invalid JSON as before | Preserved + Intentional improvement |
| `POST /api/public/subscribe` | none | bounded body | unchanged except 413 above 64 KB | Preserved + Intentional improvement |
| `GET/POST /api/public/unsubscribe` | token capability + same-origin check | POST body read through `readLimitedForm` (32 KB) | an oversized or unreadable body now gives the existing "link incomplete" page (HTTP 400), which is also what the original gave for an unparseable form; token, reason and origin logic untouched | Preserved + Intentional improvement |
| `GET /api/public/sequence-unsubscribe` | enrollment id capability | unchanged | unchanged | Preserved |
| `POST /api/v1/website/flight-inquiries` (authenticated website API) | `Authorization: Bearer WEBSITE_API_KEY(+_NEXT)`, private route, `Idempotency-Key`, fingerprint table | location fallback only | unchanged: 201/200/400/401/404/409/413(32 KB)/415/429/503 semantics; `{ ok, leadId, duplicate }` | Preserved |
| `GET /api/health` | none; detail with `Bearer CRON_SECRET` | **anonymous answer reduced to `{ "status": "ok" \| "down" }` (HTTP 200/503 unchanged)**; the full report (`database`, `pool`, `readiness`) is returned only when the request carries the cron secret | status codes unchanged; **fields removed from the anonymous body** | Intentional replacement — **Potential regression** for any external reader of the detailed fields |
| `GET /api/cron/{tasks,sequences}` | `CRON_SECRET` bearer (503 in production if unset) | handlers now call the non-action sweeps | unchanged | Preserved |
| `GET /api/cron/leads`, `POST /api/cron/cvv-cleanup` | same | unchanged | unchanged | Preserved |
| `GET /api/attachments/[id]/file`, `PUT …/upload` | session | unchanged | unchanged | Preserved |
| `GET /api/auth/gmail/callback` | session + OAuth state cookie | unchanged | unchanged | Preserved |
| `GET /api/track/quote-open/[token]` | token | unchanged | unchanged | Preserved |

Webhooks: the CRM exposes none besides the Gmail OAuth redirect and the open-tracking pixel; both unchanged. Company scoping: public inquiry endpoints still require an explicit `companyId` and reject an unknown company ("Unknown company"); the website API fixes the company from the credential; `contact-inquiry`'s derived id includes the company, so keys never collide across companies. External service integrations (Gmail API through `MailComposer`, Google sign-in, Cloudflare tunnel) are unchanged in structure; `nodemailer` moved to 10.x but only `MailComposer` is used (verified by the Gmail-send unit tests, including the Bcc handling).

## 4. Compatibility with each caller

| Caller | Verdict | Basis |
| --- | --- | --- |
| **Updated Business Flights website** (API-only) | **Compatible** (stand-in level) | its client posts `flight-inquiries` with Bearer key + Idempotency-Key + signed visitor context; `contact-inquiry` with a key of the form `<uuid>.<16 hex>` (53 characters — inside the CRM's 8–200 character pattern) and no credential; `subscribe` with company/email/source. Request fields and status codes are within the contract above. 40 client/contract tests (Playwright "Infrastructure", stand-in CRM) passed when run earlier today (they were not re-run in this read-only audit); the 6 live-contract tests against a real CRM are **deferred**. Verdict for real-database behaviour: **Unverified**. |
| **Existing live Business Flights website** (the original, which writes to the CRM database directly with its own Prisma runtime role) | **Compatible by schema** (static) | the CRM schema change is additive: two nullable `Account` columns and one new table with a cascade foreign key to `ContactInquiry`; no column, table, enum value or constraint the original website writes was altered, and the optional `submissionInfo` relation is not required on insert. The live role's privileges on the new table are irrelevant (the website never touches it). **Unverified** against the real production role and data. |
| **Existing CRM users** | **Compatible** | same navigation and permissions; additions are additive; the only behavioural reductions are the removed period-comparison on Commissions/Salesboard (documented) and stricter campaign HTML (below) |
| **Existing integrations that read `/api/health`** | **At risk** | see 5-1 |
| **Existing deploy tooling** (`deploy/verify.sh`, `ci-smoke.sh`, `scripts/healthcheck.mjs`) | **Compatible** | the two scripts that parse the detailed report now send the cron secret (from inside the container, where `CRON_SECRET` is already a required variable); `healthcheck.mjs` reads only `status`, which is unchanged |

## 5. Potential regressions and their evidence

1. **Detailed `/api/health` no longer anonymous.** Any monitor, dashboard or script that parses `readiness`/`database`/`pool` from an unauthenticated request will receive only `status`. In-repository consumers were updated and verified by reading; external consumers are unknown. *Mitigation:* send `Authorization: Bearer $CRON_SECRET`, or accept the minimal answer. The change is a security improvement (it removed card-vault state, key label, TLS mode, schema and integration status from the public surface).
2. **Campaign HTML sanitiser.** Allowed: paragraphs, headings, lists, emphasis, links (http, https, mailto, tel), images (http, https, small inline base64 raster), tables with layout attributes, div/span, inline typography/colour/spacing/border/size CSS. Removed: `<script>`, `<style>`, `<iframe>`, forms, SVG, event handlers, `javascript:`/`data:` links, CSS `url()`/`expression()`/`@import`, `position`, `z-index`. A stored campaign that relied on any removed item will be sent without it (stored records are not rewritten; they are cleaned at preview and send). The shipped starters are asserted unchanged in content. *Mitigation:* preview before sending an old campaign.
3. **Body limits.** `contact-inquiry`, `crm-inquiry`, `lead-capture`, `subscribe` now answer 413 above 64 KB, `unsubscribe` treats a body above 32 KB as an incomplete link. The longest legitimate field is a 5,000-character message, so no genuine submission is near the limit.
4. **Idempotency semantics on `contact-inquiry`** are new and only active for callers that send `submissionId`. PostgreSQL behaviour (advisory lock on the derived id, primary-key reuse, 409 path) is **Unverified**.
5. **Dependency upgrades** (Next 16.3.8→16.4.6, Nodemailer 9→10, Zod 4.4→4.6, Tiptap 3.30→3.34): all tests, type-check, lint and build pass; runtime behaviour under real traffic is **Unverified**. Docker's Node 24 image satisfies the engines of all of them.
6. **Server actions open to any signed-in session** (unchanged from the original): `lead-queue.ts` exports `distributeNewWebsiteLead`/`distributePendingWebsiteLeads` without an actor check, and `reference-data.ts` agent lists trust a caller-supplied `companyId`. Reaching them needs an authenticated session. Not a regression; recorded for the next hardening pass.

## 6. What the tests do and do not prove

| Test family | Proves | Does not prove |
| --- | --- | --- |
| Route/handler tests with mocked Prisma | request validation, status codes, response shapes, no database touch on refusals | transaction behaviour, locks, constraints |
| `public-inquiry-idempotency.test.ts` | the contract above, with an in-memory store | concurrent behaviour on PostgreSQL |
| Migration file tests | file integrity (BOM, NUL, UTF-8, directory completeness) | that the SQL applies, or its effect on data |
| Component tests (jsdom) | rendering and interaction | real browser/server flow |
| 562 skipped database-gated tests | nothing (skipped) | — |

## 7. Decision

**Functional compatibility: READY WITH CONDITIONS.** Every original workflow, route and public contract is retained; the changes are additive, documented replacements or security hardening, and no confirmed regression was found. Conditions: (1) the database-backed verification that was deferred must run before relying on the new sequence, inquiry-idempotency and sign-in-location code paths; (2) external readers of `/api/health` must be found and given the cron secret or told; (3) old stored campaign HTML should be previewed before reuse.

## 8. Corrections before deployment (functional)

| Priority | Item |
| --- | --- |
| P0 | Run the deferred database-backed tests, the migration application and the six website contract tests against a disposable PostgreSQL. |
| P1 | Inventory and update external `/api/health` consumers. |
| P1 | Confirm the website's `CRM_COMPANY_ID`/`WEBSITE_API_KEY`/`LEAD_INGEST_SECRET` match the CRM's values on the live private network (not verifiable from here). |
| P2 | Preview existing campaigns once through the new sanitiser. |
| P3 | Actor checks for the two `lead-queue` actions and `companyId` derivation in the reference-data agent lists. |


---

# Final investigation (2026-11-13, evening) — campaign sanitiser, request-size limits, lead-queue actions, test reliability, workflow review

Decision for this report after the final investigation — **Functional compatibility: READY WITH CONDITIONS** (unchanged). Conditions: database-backed behaviour is unverified (deferred), external `/api/health` readers are unknown, old stored campaigns should be previewed once.

## 1. Campaign HTML sanitiser — compatibility with legitimate campaigns

**What was inspected.** The editor (TipTap starter kit + Link + Image) writes plain, class-free HTML with `text-align` styles; `RichTextEditor` feeds `campaign-form.tsx`; the server action `previewCampaignHtml` returns the cleaned copy and the form shows it in an iframe with `sandbox=""` and a restrictive CSP; `marketing-campaigns.ts` cleans at create and update; `templates.ts` (`buildMarketingCampaignEmail`) cleans again before the branded layout and the link-to-button promotion. Stored records are not rewritten; they are cleaned when previewed or sent. The sanitiser is `sanitize-html` (parser-based, entity-decoding, allow-list).

**Necessary for legitimate rendering (allowed):** paragraphs, line breaks, headings h1–h6, bold/italic/underline/strike, lists, blockquote, code/pre, hr, links (http, https, mailto, tel, relative/placeholder targets) with `target=_blank` → `rel="noopener noreferrer"`, images (http/https and small inline base64 raster) with alt/title/width/height, div/span/center, tables with `width/height/align/valign/bgcolor/border/cellpadding/cellspacing/role/colspan/rowspan`, and inline CSS for colour, background colour/gradient (no `url()`), fonts, sizes, weight, line height, spacing, borders, radius, text alignment/decoration/transform, widths/heights, and `display` limited to block/inline/inline-block/table/table-cell/table-row/none.

**Must stay prohibited (security):** `<script>`, `<style>` blocks, `<iframe>`/`<object>`/`<embed>`, forms and controls, SVG/MathML, `<meta>/<link>/<base>`, event-handler attributes, `javascript:`/`vbscript:`/`data:` link targets (and `data:` images other than small PNG/JPEG/GIF/WebP), CSS `url()`, `expression()`, `behavior`, `-moz-binding`, `@import`, backslash escapes, `position`/`z-index` (an email must not paint over its own footer or the CRM page).

**Fixtures and results** (new file `src/server/email/__tests__/campaign-html-fixtures.test.ts`, 16 tests, all passing; synthetic content only, no production record read): (1) editor output — every word of visible text survives, structure kept (heading, emphasis, lists, quote, rule, `pre/code`, image with alt/title/width, mailto/tel links), centred paragraph keeps its alignment, link keeps its tracking query string and `target`, the editor's `nofollow` rel is replaced by `noopener noreferrer`, merge-style placeholders (`{{firstName}}`, `[first_name]`, `href="{{unsubscribe_url}}"`) untouched, output idempotent; (2) a hand-built 600 px newsletter — all text survives; nested layout tables with `bgcolor/cellpadding/cellspacing/role` kept; background colours, fonts, sizes, weights, letter-spacing, line height, margins, borders, radius, alignment and decoration kept; the call-to-action button keeps `display:inline-block`, padding, background, radius; footer unsubscribe link kept; (3) pasted Word/Outlook markup — text survives, the `<style>` block, conditional comment, Office XML and `<o:p>` go, real typography (size, family, margin) and `<b>` stay, `mso-*` declarations and `class/id/data-*` go; (4) a hostile mix — nothing executable, fetchable, embeddable or posting survives while harmless neighbouring text and a safe declaration beside a dangerous one remain. The email test directory now holds 18 files and 367 tests (351 existing + these 16), all passing.

**Compatibility limits (documented, not defects):** `<font color/face/size>` loses its attributes (text stays) — an old template relying on `<font color>` loses that colouring; `float`, flex layouts and `box-shadow` are not on the allow-list (email clients mostly ignore them, content stays readable in normal flow); `class`/`id` are dropped (so any `<style>`-driven design disappears, which email clients strip anyway). **No correction was made**: no legitimate content was found to be broken, and widening the list for `<font>` has no evidence of need (it would be safe to add if you want it). The sanitiser was not weakened.

## 2. Request-size limits — compatibility

| Endpoint | Limit | Applies to | Enforced | Failure |
| --- | --- | --- | --- | --- |
| `POST /api/public/contact-inquiry`, `/crm-inquiry` | 64 KB | the website's server (Business Flights "Get In Touch") and the CRM's own form | before parsing: declared `Content-Length` over the cap is refused unread; otherwise the stream is counted and cancelled at the cap | HTTP 413 `{ ok:false, error:"Request body is too large." }` |
| `POST /api/public/lead-capture`, `/subscribe` | 64 KB | legacy website lead, newsletter | same | same |
| `POST /api/v1/website/flight-inquiries` | 32 KB (unchanged) | the website backend | same | HTTP 413 `payload_too_large` |
| `POST /api/public/unsubscribe` | 32 KB | the unsubscribe page's own form | same (form reader) | the existing "link incomplete" page (HTTP 400) |

(There are no website *Server Actions* with a CRM limit: the website's actions call these HTTP endpoints from its own server.) **Headroom measured by test** (`body-limit-headroom.test.ts`, synthetic data, field maxima from the endpoints' own validation): the largest genuine contact request (every field at its maximum, 5,000 characters of three-byte text) is under one third of 64 KB; even 5,000 characters that each need a six-byte JSON escape stay under 64 KB; the largest genuine flight request is under the website API's 32 KB; a full-length unsubscribe comment (1,000 characters, the textarea's `maxlength`) of three-byte text is under half of 32 KB in urlencoded and multipart encodings. The caps are therefore consistent across related endpoints (shared helper per body type; stricter only where the payload is inherently small) and **no limit was raised**. Safe failure: no parsing or database access happens for an oversized body (tests prove the database is never touched); the website maps a 413 to its generic "unavailable" error — no false success, and for the contact form no automatic retry.

## 3. Unauthenticated lead-queue server actions

| | `distributeNewWebsiteLead(leadId)` | `distributePendingWebsiteLeads()` |
| --- | --- | --- |
| Reachable from outside? | only as a Server Action by a **signed-in** account with access to a page that bundles it — the manifest lists `/leads` and `/leads/[id]`; `src/proxy.ts` redirects unauthenticated and forged-cookie requests to `/login` (probed) | same |
| Reads | `source`, `assignedAgentId`, `queueDistributedAt` of any lead id (no company check); answers with an enum (`already_assigned`, `not_a_website_lead`, `no_active_workers`, …) | up to 50 unassigned website leads (ids and company ids) — nothing returned except `{ scanned, distributed }` |
| Modifies | for an *eligible* lead (website source, unassigned, never distributed) it makes the same offer to the next worker **of the lead's own company** that the system makes automatically; expires stale offers | the same, for the pending batch (oldest first) |
| Intended public? | no — server-side helper | no |
| Checks / validation / rate limit | no actor check; `leadId` is not validated; no rate limit | none |
| Legitimate callers | server-side only: `lead-intake.ts` (website lead creation), `actions/leads.ts` (create lead), `api/cron/leads` (behind `CRON_SECRET`), `lead-queue.ts` itself | `api/cron/leads`, `lead-queue.ts` |
| Proxy/permission protection | session + role guard for the host pages | same |

Assessment: **low severity** — the effect equals what the system does by itself moments later, targets only unassigned website leads that were never distributed, and discloses an enum; the exposure is "an authenticated staff user, or anyone who obtains a staff session, can trigger early offers, or repeatedly invoke the sweep (resource use)". It is **unchanged from the original**. The right fix — move the two functions and their private helpers into a non-action module and import them from the three server callers, as was done for the two other sweeps — is not minimal: three importing source files, `lead-queue.ts`, and 13 test files that import or mock the functions. Because adding an actor check in place would break the cron route, lead intake and lead creation (they run with no signed-in user), **nothing was changed**. Proposed for approval (A-6); not a release blocker.

## 4. Test reliability and the worker cap

Verified by evaluating `vitest.config.ts`: default `maxWorkers` 4; `VITEST_MAX_WORKERS=2/8/16` is honoured; empty, `0`, negative or non-numeric values fall back to 4; `globalSetup` (database guard), `testTimeout` 45 s and `hookTimeout` 60 s are present; the CI workflow runs `npx vitest run --no-file-parallelism`, so the cap does not apply there. Two complete runs earlier today gave identical results (4,003 passed, 562 skipped) in 666 s and 674 s on this loaded machine (an earlier 3-worker run: 208 s), so reliability is demonstrated and speed is load-dependent. The cap changes parallelism only: no assertion, timeout or test was changed — checked by comparison with the original: all 287 original test files exist; in the 284 comparable files test count rose 3,758 → 3,810 and `expect()` calls 8,920 → 9,084, no file has fewer of either, no file gained a skip marker. Skipped tests are listed in every run summary (562) and are not counted as passes.

## 5. Final targeted workflow and permission review

| Area | Result |
| --- | --- |
| Authentication, sessions | `proxy.ts` and the session helpers unchanged apart from the sign-in write (adds two nullable columns; **requires the migration before the new image starts**); single-device and 24-hour rules, step-up for privileged actions unchanged; `session-enforcement-coverage` passes |
| Roles and permissions | `permissions.ts`: two predicates added (bulk delete Admin-only; bulk enrol = the existing sequences rule); nothing weakened |
| Leads, contacts, companies, accounts | pages unchanged apart from bulk selection and the active-sequence notice |
| Website lead / flight request / contact / newsletter intake | contracts in the section above; additive only; company scoping preserved (explicit `companyId` on public endpoints, credential-fixed company on the website API) |
| Campaigns, email generation | sanitiser (section 1); Gmail sending through `MailComposer` (Nodemailer 10) with the Bcc handling; unsubscribe unchanged |
| Tasks, notifications, background jobs | sweeps moved out of `"use server"`; cron routes unchanged in authentication (constant-time bearer, 503 when unset in production); the in-process poller **still starts by default** (new opt-out only) |
| File uploads | local storage only (R2 module removed in the staged merge, no remaining reference except tests asserting absence); routes and permission checks unchanged |
| Users page / latest sign-in location | one row per account, latest sign-in only, Admin-only, no coordinates; provenance columns new; shows "Location unavailable" without a GeoIP file |
| Reports, dashboard, activity history, search/filtering | unchanged except Commissions/Salesboard comparison removal (documented) |
| Data loss | none found: no migration drops or rewrites anything; deletion semantics unchanged except the new cascading child table |
| Unauthorised access | none introduced; the two inherited exposures (section 3 and the company-id agent lists) are recorded |

## 6. Updates to earlier statements in this report

The earlier text counted "9" tests in the inquiry-idempotency integration file; the file contains **8**. The earlier "40 client tests" statement refers to the website repository's Playwright "Infrastructure" tests run earlier today against a stand-in CRM; they were not re-run in this read-only phase.
