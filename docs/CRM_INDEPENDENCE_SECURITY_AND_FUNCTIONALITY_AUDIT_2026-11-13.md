# CRM independence, security and functionality audit — 2026-11-13

Audit time about 05:30–06:30 PST. Target: **`F:\Claude Workspace\compass-tools-updated`** (updated CRM, fixed port **3001**). Reference only: `F:\Claude Workspace\compass-tools` (original CRM, fixed port **3000**). The companion website report is `F:\Claude Workspace\Travel Agency Website-updated\docs\FOUR_PROJECT_INDEPENDENCE_AND_WEBSITE_AUDIT_2026-11-13.md` (it also holds the four-project server table and the website findings). Existing CRM documents (`docs/FOUR_PROJECT_COMPARISON_2026-11-13.md`, `docs/SECURITY_POSTURE.md`, `docs/WEBSITE_LEAD_API.md`) were used as historical references; every finding below was **re-checked against the current code**.

**Boundaries kept.** Nothing in either CRM project was edited, staged, unstaged, committed, reset, stashed, merged, rebased or switched; no dependency, package file, lockfile, environment file, launch configuration or database was changed or touched; no PostgreSQL was installed or configured (database-backed work remains deferred); nothing was submitted to the CRM; no production data or credentials were used. **The updated CRM's Git state is preserved exactly:** branch `work/commission-salesboard-notes-ui`, HEAD `5a77976`, `MERGE_HEAD c6b8d8e`, 79 staged / 55 unstaged / 84 untracked (208 entries), 0 unmerged, 1 stash — the status hash was identical before the server start, after the tests and after TypeScript/ESLint (`59C7ACBF871FDEA0`). This report is one new untracked file; it does not touch the index.

Evidence legend: **[S]** source inspection, **[X]** executed today, **[H]** live HTTP on the running 3001 server, **[P]** historical (another report), **[N]** not run / not verifiable.

---

## 1. Project identity, port and server verification

| Item | Updated CRM | Original CRM |
|---|---|---|
| Directory | `F:\Claude Workspace\compass-tools-updated` | `F:\Claude Workspace\compass-tools` |
| Fixed port | **3001** (`npm run dev` = `next dev -p 3001`; launch config `compass-tools-updated-dev`, `autoPort:false`) | **3000** (`next dev -p 3000`). Its `launch.json` also holds `compass-tools-prod` on port **3002** (existing, not mine, not edited) |
| Git | own repo; branch `work/commission-salesboard-notes-ui`, HEAD `5a77976`; **merge in progress** (`MERGE_HEAD c6b8d8e` = `github/feature/website-api-idempotency-fingerprint`, 15 incoming commits, `README.md` conflict resolved, 0 unmerged entries, uncommitted); 208 entries; 1 stash ("pre-merge: UI dev-CSP change") | **git cannot read the repository**: `.git/config` is 1,034 NUL bytes (corrupted; "bad config line 1"). Branch and HEAD recovered from raw files: `feature/website-api-idempotency-fingerprint` @ `c6b8d8e`. Working-tree status unknown. **Not repaired** (reference project) |
| Environment files (names only) | `.env.example` only — **no real `.env`** | `.env` (7,061 B: `DATABASE_URL` **non-loopback**, Google OAuth ID/secret, three encryption keys, `APP_BASE_URL` loopback) and `.env.example` |
| Stack | Next.js 16.3.8, React 19.2.8, Prisma ^7.9.1, vitest | Next.js 16.3.8, same |
| `node_modules` / `.next` | own / own (build `-2rvpm1cA…` 11/13 02:59 + dev dir) | own / own (build `a20lsm8d…` 2026-10-13) |
| Server | **running**: listener PID 2132 (`next dev -p 3001`, parent 9392), started by this session at 05:43 | **not running — deliberately not started** |

**Server verification (3001).** All command-line paths are inside `compass-tools-updated`. `GET /` → 200, title "Compass Tools — CRM for Travel Agencies" (107 KB marketing page); `GET /login` → **500** and `GET /api/health` → **503** — both caused by the missing environment (`GOOGLE_CLIENT_ID is not configured — set it in .env` at `src/server/auth/google-config.ts:20`; database not configured), not by a code defect. Server log: `[health] DATABASE_CHECK_FAILED`, `[health] RECORD_FAILED`. The in-process task poller started at boot (see C9) and fails harmlessly each minute without a database. No other session's process was disturbed; the only peer session ("Compass Tools CRM implementation") was idle.

**Why 3000 was not started.** The original CRM's `.env` holds a non-loopback database URL, and `src/instrumentation.ts` starts a 60-second poller at server boot (`processDueTaskNotifications`) that queries the database and can create notifications/emails. Starting it would run background work against a non-loopback database, which your rules forbid for testing. Nothing was started, so nothing needs cleanup. If you want the original CRM served for visual comparison, that needs a decision on its database variable first.

Independence of the updated CRM: 864 source files, 1,819 relative and 2,413 `@/` imports, **0 resolve outside the project**; the only unresolved import is inside the generated Prisma client (`src/generated/prisma/internal/prismaNamespace.ts → ./generated/prisma/client`, also true of the generated code in the other projects); it references the website only in one comment (`scripts/vercel-build.mjs:21`); it has its own `node_modules`, `.next`, `package.json`/lockfile and launch config. The website imports nothing from it.

**Action not completed:** stopping this server (to free memory) was denied by the permission classifier and was not retried another way; the server stays running on 3001.

---

## 2. Original versus updated CRM (hashes of every non-generated working-tree file; git unusable on the original)

| Result | Files |
|---|---:|
| Hashed: original / updated | 951 / 1,031 |
| Identical bytes | 98 |
| Identical except line endings | 774 |
| Content-modified | 75 (17 `src/server`, 13 `src/app`, 13 `src/components`, 9 generated Prisma, 7 root config, 7 `src/lib`, 3 docs, 2 `prisma`, 2 `src/test`, 2 `src/__tests__`) |
| Original-only | **4**: `.env`, `skills-lock.json`, and two **zero-byte stray files** `client` and `server` (created 2026-10-20) — nothing functional is missing |
| Updated-only | 84 |

Updated-only (what the updated CRM adds): 32 `docs/recovery-archive/*` documents and 4 other docs; GeoIP-based location provenance (`src/server/geo/*`, `scripts/geoip-database.ts`, `scripts/backfill-sign-in-locations.ts`, a 121 MB git-ignored `data/geoip/city.mmdb`); **`src/server/security/read-limited-json.ts`** (the request-size limiter — the original has none); inquiry submission information (`src/server/inquiry-submission-info.ts`, queries, `inquiry-submission.ts` action, UI panel, `InquirySubmissionInfo` model); bulk selection / bulk sequence enrolment (`bulk-selection.*`, `sequence-status-enroll.ts`, `sequence-enrollment-eligibility.ts`, dialogs); the disposable-database guard (`src/test/integration-database-guard.ts`); 23 test files; **two new migrations** (`20261108000100_sign_in_location_provenance`, `20261113000100_inquiry_submission_info`: 75 vs 73) — neither has been applied to any database. The website's idempotency-fingerprint endpoint (`src/app/api/v1/website/flight-inquiries/route.ts`, migration `20261016000100_lead_ingest_fingerprint`) exists in both projects' trees.

Verdict: the updated CRM is the original plus targeted additions; 872 of 951 original files are unchanged apart from line endings.

---

## 3. Verification of the named security concerns (current code)

| Concern | Status today | Evidence |
|---|---|---|
| Public `/api/health` details | **still present** (C3) | live unauthenticated response lists `status`, `database`, `pool`, `readiness` with 13 keys (`cardVaultKey`, `cardVaultState`, `cardVaultKeyVersion`, `cardVaultEnabled`, `environment`, `databaseTls`, `leadIngestSecret`, `websiteApi`, `signerIpCapture`, `uploadStorage`, `schema`, `pendingMigrations`, `bookingCardStorage`); `src/lib/health-check.ts:70-75` has no production redaction |
| `X-Powered-By` | **still present** (C4) | `X-Powered-By: Next.js` on `GET /` [H]; `next.config.ts` has no `poweredByHeader: false` (the website sets it) |
| Campaign HTML sanitization | **still unresolved** (C2) | no sanitizer anywhere in `src` or `package.json` (searched `sanitiz|DOMPurify|sanitize-html|xss`); stored HTML is rendered with `dangerouslySetInnerHTML` at `src/components/subscriptions/campaign-form.tsx:206,213` and sent raw (`buildMarketingCampaignEmail`, `src/server/email/templates.ts:2118`) |
| Lead IP Reveal permissions | **already addressed** (C13) | `src/server/actions/lead-submission.ts:50-90`: active session → per-account rate limit → `canViewLeadSubmissionInfo` + `canRevealBookingIp` (Admin, or Manager/Ticketing with the explicit grant) → lead visibility checked by the database (IDOR-safe) → sign-in within 15 minutes → audit row for every outcome, never containing the address |
| Dependency findings | **open** (C1) | `npm audit`: 70 vulnerabilities (2 critical, 22 high, 45 moderate, 1 low); production dependencies 61 (2 critical, 21 high) |

---

## 4. Findings, prioritised (all are proposals — nothing was changed; every fix needs your approval)

Status key: **confirmed**, **suspected**, **already fixed**, **blocked**.

### Critical
**C1 — Next.js 16.3.8 is inside the range of three published advisories (and 21 other high production-dependency advisories)** · updated CRM · Critical (by advisory severity; exploitability partly unconfirmed) · **confirmed (audit data); applicability mixed**
* Location: `package.json` `"next": "16.3.8"` (installed 16.3.8); lockfile.
* Evidence (`npm audit`, lockfile unchanged afterwards): GHSA-2464-fhr4-w9xw critical *unauthenticated RCE in the Image Optimization API when SVG files are used*; GHSA-673q-mjm6-r5xr critical *unauthenticated RCE in `use cache` functions returning typed arrays*; GHSA-p3m5-59mp-jv5r high *denial of service in App Router using Server Actions*; all `>=16.0.0 <=16.4.0`, fix `next@16.4.6`. Other critical/high: `proxy-addr` IP spoofing (critical, transitive), `body-parser` DoS, `@prisma/config`/`deepmerge-ts`, `@tiptap/core` (prototype-attribute and ReDoS), `js-yaml`, `zod`, `nodemailer`, `undici`, `systeminformation`, `mysql2`, `prosemirror-view`, `vite`, `glob`, `fast-uri`, `brace-expansion`, `@opennextjs/*`, `shadcn`, `@modelcontextprotocol/sdk` (several are build/tooling packages; I did not triage each).
* Applicability: the app uses **neither** `use cache` nor `next/image`, and sets no `images` configuration, so the two RCE preconditions are not evidently met (default image optimisation refuses SVG); the **Server Actions DoS applies** because the CRM is built on server actions. The website runs Next 16.4.2 (outside the range) and has 0 production advisories.
* Impact: remote denial of service against authenticated and public actions; potential RCE if an affected feature is ever enabled.
* Root cause: dependency age. Minimal fix: upgrade `next` (and `eslint-config-next`) to ≥ 16.4.6, then address the production-path highs by direct upgrades where available.
* Dependencies/risks: minor-version framework upgrade; regression risk in server actions, proxy and CSP; the merge in progress must be resolved first.
* Approval: **required** (dependency upgrades are not authorised).
* Test: full `vitest` (3,882 pass today), `tsc`, ESLint, a production build, then the login/session flow and an authenticated smoke test on a disposable database (**deferred**).

### High
**C2 — Campaign HTML is not sanitised: stored XSS from a Marketing Agent to an Admin** · updated CRM · High · **confirmed (code)**
* Location: `src/components/subscriptions/campaign-form.tsx:206,213`; `src/server/actions/marketing-campaigns.ts:35,77-83,212-218`; permissions `src/lib/permissions.ts:264-266` (`canViewSubscriptions`: ADMIN or MARKETING_AGENT).
* Evidence: `htmlContent: z.string().min(1)` is stored as is; opening a campaign renders it with `dangerouslySetInnerHTML`; the base CSP allows inline scripts and handlers (`script-src 'self' 'unsafe-inline' …`, `next.config.ts`/`src/lib/csp.ts`); no sanitiser library exists.
* Impact: a Marketing Agent (or a compromised agent account) can plant script that runs in an Admin's session when the admin previews or edits the campaign (privilege escalation, data access, session actions); the same HTML is also emailed to subscribers.
* Root cause: trust in staff-authored HTML; no allow-list.
* Minimal fix: sanitise on save with an allow-list (a maintained library such as `sanitize-html`/DOMPurify) and render the preview in a sandboxed iframe (`sandbox` without `allow-scripts`); keep email-safe tags only.
* Dependencies/risks: adds a dependency (needs approval); existing stored campaigns need a one-time sanitise pass; email layout regressions.
* Approval: **required**. Test: unit tests with `<img onerror>`, `<script>`, `javascript:` URLs, event attributes; Playwright preview check; email-template snapshot tests.

**C8 — The working tree is mid-merge and the website's contract depends on it** · updated CRM (and website) · High (process/integrity) · **confirmed**
* Evidence: `MERGE_HEAD c6b8d8e`; 15 incoming commits; 79 staged entries; 55 unstaged; 84 untracked; 1 stash; index last written 2026-11-09 01:18. The merge brings the website-API idempotency-fingerprint work; aborting it would remove it. The original CRM's repository is unreadable (all-NUL config).
* Impact: the baseline for review/deployment is unclear; a stray `git merge --abort`, blanket `git add .` or `git stash pop` would change or lose work.
* Minimal fix: decide to complete the merge and commit it deliberately (reviewing the 79 staged entries and the stash), or to abandon it knowingly; separately, ask whether to repair the original CRM's `.git/config` (reference project; not touched).
* Approval: **yours**. Test: after the decision, run the full vitest and a build.

### Medium
**C3 — Public `/api/health` discloses card-vault, key-version, secret-configuration and migration state** · updated CRM · Medium · **confirmed (live)**
* Location: `src/app/api/health/route.ts:10-12`, `src/lib/health-check.ts:31-75`.
* Evidence: an unauthenticated GET returned the keys listed in §3, including `cardVaultKeyVersion`, `leadIngestSecret`, `websiteApi`, `pendingMigrations`, `environment`.
* Impact: reconnaissance value (which secrets are set, whether the vault is misconfigured, schema state).
* Minimal fix: public response `{status}` only (HTTP 200/503); the detail already belongs on the Admin-only System Health page (`/system-health`, `canViewSystemHealth`) or behind an authenticated/cron-secret probe. Keep the container/uptime probe working.
* Risks: uptime monitors that parse the detail. Approval: required. Test: unauthenticated GET returns no readiness keys; the System Health page still shows them to an Admin.

**C5 — "Process due" actions have no in-function authorisation and are live Server Actions** · updated CRM · Medium · **suspected (needs dynamic verification)**
* Location: `src/server/actions/sequences.ts:352` (`processDueSequenceSteps`), `src/server/actions/tasks.ts:240` (`processDueTaskNotifications`) — both begin with a database scan, no `getCurrentAccount()`/permission check; both are imported by client buttons (`src/components/sequences/process-due-button.tsx:8`, `src/components/tasks/process-due-tasks-button.tsx:8`) and by the cron routes.
* Evidence: auth-coverage map of all 138 exported server actions: 128 reference an authentication/permission primitive; the 10 that do not are four token-based customer booking-page actions, `confirmCancellationByCustomer` (token), `signOut`, `distributeNewWebsiteLead`/`distributePendingWebsiteLeads` (server-internal) and these two. The proxy gates every protected route with a verified session (24 h, single active device, fail-closed on database errors), and a server action can be invoked only through a route whose bundle includes it, so reachability by an anonymous caller is **not demonstrated**.
* Impact if reachable: anyone able to POST the action could force early processing (extra load, earlier sends of already-due steps).
* Root cause: the function is both the cron worker and the UI action. Minimal fix: split into an internal worker (called by cron/poller) and authorised wrappers for the buttons (`canViewSequencesPage`/`canViewTasks`).
* Approval: required. Test: unauthenticated Next-Action POST on a staging build → refused; cron route and buttons still work.

**C6 — No effective CRM-side per-visitor rate limit for website-mediated contact/newsletter, and the contact route's duplicate guard is off** · updated CRM + website · Medium · **confirmed (code)**
* Location: `src/server/security/rate-limit.ts:55-58` (`getClientIp` undefined → `{ allowed: true }`, documented "fails OPEN"), `src/lib/request-ip.ts` (nothing trusted unless `TRUSTED_PROXY`), `src/app/api/public/contact-inquiry/route.ts:11-19`, `src/server/public-inquiry.ts:64-68` (`duplicateWindowMs` "Off by default").
* Evidence/impact: the website's server posts these two requests without a Cloudflare header, so the CRM cannot key them to the visitor; the website's in-memory limiter is the only per-visitor control, and a repeated/timed-out contact message can be stored twice. Direct internet callers of the same public routes *are* limited per Cloudflare IP when `TRUSTED_PROXY` is set.
* Minimal fix: enable `duplicateWindowMs` (e.g. 10 min) for the contact route; for the limiter, key server-to-server public calls on the verified signed visitor context or add an edge rate rule. Approval: required. Test: stand-in unit test (same message twice → one inquiry); database-backed test **deferred**.

**C9 — The in-process 60-second poller runs in every Node runtime, including production** · updated CRM · Medium · **suspected**
* Location: `src/instrumentation.ts:15-27` (`register()` starts `setInterval(processDueTaskNotifications)`; guarded only against edge runtime and re-registration; its own comment calls it the "dev-environment stand-in" for a real scheduler); `/api/cron/tasks` is the production entry point (`src/server/security/cron-auth.ts` fail-closed in production).
* Evidence: no `NODE_ENV`/deployment guard in the file. Impact: in production the poller and an external cron can both process due tasks, and several instances would each run it; duplicate in-app notifications/emails are possible unless the function claims rows atomically (not verified — needs the database).
* Minimal fix: start the poller only when an explicit variable (e.g. `ENABLE_IN_PROCESS_POLLER=true`) is set, defaulting off in production. Approval: required. Test: database-backed concurrency test (**deferred**).

**C11 — Everything database-dependent is unverified** · updated CRM · Medium · **blocked (deferred by decision)** — 25 database-backed files plus 3 other environment-gated files (28 skipped files, **569 skipped tests**): sequence advisory-lock concurrency, the two new migrations, lead idempotency end to end, rate-limit counters, website-API contract tests, browser flows. None passed and none was attempted.

### Low
**C4 — `X-Powered-By: Next.js` is sent** · Low · **confirmed** — `next.config.ts` lacks `poweredByHeader: false`. Minimal fix: one line. Approval: required. Test: header absent on `GET /`.
**C7 — `POST /api/public/unsubscribe` reads `req.formData()` with no byte cap** · Low · **confirmed** — `src/app/api/public/unsubscribe/route.ts:91` (every JSON route uses `readLimitedJson`, 64 KB; the flight endpoint has its own 32 KB reader). Mitigated by the route's rate limit. Minimal fix: check `Content-Length`/stream count before `formData()`.
**C10 — `/login` is an unhelpful 500 when Google sign-in is not configured** · Low · **confirmed in an unconfigured environment** — `src/app/login/page.tsx:139` calls `getGoogleClientId()` which throws. Minimal fix: render a clear "sign-in is not configured" message. Environment-specific; production configuration avoids it.
**C12 — A 121 MB GeoIP database is required at runtime but git-ignored** · Low · **confirmed** — `data/geoip/city.mmdb`; deployment must supply it (`npm run geoip:install|download|verify`); licence/attribution handled in `docs/GEOIP.md` and `src/server/geo/geoip-attribution.ts` (CC BY 4.0 credit required for the recommended DB-IP data). Verify attribution is shown where location is displayed.
**C13 — Lead IP Reveal** · **already addressed** (see §3); no action.
**C14 — A task-reminder failure logs the send-error object** · Low · **suspected** — `src/server/actions/tasks.ts:338` logs `result.error`; an SMTP error string can include a recipient address. Other logs use fixed tags. Minimal fix: log the error class/category only.
**C15 — Body limit of 5 MB for every Server Action** · Info · deliberate — `next.config.ts:84-97` (bulk subscriber paste, authenticated, with a 2,000-email application ceiling). No change proposed.
**C16 — CSP allows `'unsafe-inline'` scripts (and `'unsafe-eval'` in dev)** · Info — documented trade-off in `next.config.ts`/`src/lib/csp.ts`; card/payment routes get a stricter nonce CSP from `src/proxy.ts`. It is what makes C2 exploitable, so C2's fix matters more than tightening CSP.

---

## 5. Authentication, access control and session review (source)
* **Sign-in:** Google ID token verified server-side (`src/server/auth/verify-google-token.ts`); access only for a pre-provisioned account in `ACTIVE` status (`authorizeGoogleUser`, `src/server/auth/google-authorization.ts`); first admin bootstraps only via `INITIAL_ADMIN_EMAIL`.
* **Session:** random token; cookie `httpOnly`, `secure` in production, `sameSite=lax`, 24 h (`src/server/auth/establish-session.ts:64-68`); server-side single active session per account, 24 h absolute expiry, revoked sessions recorded with a hash, "sign out all users" for Admin; the proxy fails **closed** on database errors.
* **Route guards:** `src/proxy.ts` role predicates per route prefix (dashboard, contacts, leads, quotes, sequences, tasks, bookings, get-in-touch, crm-inquiries, system-health, subscriptions, commissions, salesboard); customer quote pages (`/quote/[token]`) are public by token and get a strict nonce CSP.
* **Server actions:** 128 of 138 reference an auth/permission check (C5 lists the rest); admin-only actions use `canManageAccounts`/`canManageSystemSettings` (ADMIN only).
* **APIs:** `/api/v1/website/flight-inquiries` — private-network gate (404 via Cloudflare), Bearer key ≥ 32 chars with rotation (`WEBSITE_API_KEY_NEXT`), constant-time comparison, global failure counting then 429, own 120/min budget, Content-Type 415, 32 KB cap (413), required `Idempotency-Key`, strict schema (unknown fields 400), request-hash fingerprint (409 on a different request), audit rows, generic 500 JSON with no stack. Public routes (`contact-inquiry`, `crm-inquiry`, `lead-capture`, `subscribe`, `unsubscribe`, `sequence-unsubscribe`) are unauthenticated by design, `companyId`-scoped, rate limited per trusted IP (C6), body-capped (C7 exception). Cron routes fail closed in production without `CRON_SECRET`. No CORS headers exist on any API route (same-origin only); the attachment upload route also checks `Origin`.
* **Secrets:** card vault, IP and Gmail-token encryption keys are separate; the website key is separate from `CRON_SECRET` and `LEAD_INGEST_SECRET`; `.env` is absent from the updated project.
* **Personal data in logs:** fixed tags throughout (one exception, C14).

## 6. Functional review (source, existing tests, one live page)
The CRM contains the areas you listed: leads (list/detail), contacts (+ bulk import), accounts/users with roles and permissions, company settings, bookings, quotes (+ exchange), sequences (+ bulk enrolment), tasks (+ notifications and a poller), subscriptions and marketing campaigns, two inquiry inboxes (Get In Touch for the website, CRM inquiries for the CRM's own site), commissions, salesboard, system health, public quote pages, Gmail OAuth connection, attachments, GeoIP-based location display, website lead ingestion. "Calling" is a `tel:` link button (`src/components/crm/call-button.tsx`); there is **no telephony provider integration**. There is no CSV export feature (so no spreadsheet-formula-injection surface). Authenticated screens **could not be exercised**: without `.env`, Google OAuth and a database there is no way to sign in, so navigation, dashboard, tables, dialogs, loading/empty/error states and responsive layout were **not reviewed in a browser**; only the public marketing page loaded (200). Functional confidence therefore rests on the unit/component tests (§8) and source review, not on interactive verification.

## 7. Database, Prisma and concurrency (static only — no database was reachable or touched)
85 model/enum declarations and 28 unique constraints in `prisma/schema.prisma`; 75 migrations (original 73 + 2 new, both unapplied); 33 `$transaction`/advisory-lock uses across 20 server files. Notable designs: lead id derived from the idempotency key with primary-key-collision detection (`isLeadIdCollision`, `src/server/lead-intake.ts:86-94`) plus a stored request hash; atomic fixed-window rate-limit counters via `INSERT … ON CONFLICT … RETURNING` (`src/server/security/rate-limit.ts:68-73`); a transaction-scoped advisory lock for the optional inquiry duplicate guard (`src/server/public-inquiry.ts:176-177`); strict TLS posture with an explicit allow-list for unencrypted hosts (`db`, `localhost`, `127.0.0.1`, `::1`, `src/lib/db-tls.ts`). **Not verifiable without a database:** migration safety and rollback, sequence advisory-lock behaviour under concurrency, query performance, connection handling under load, duplicate prevention end to end. Deferred by your decision; no database guard was changed.

## 8. Tests executed (exact results)
| Check (run from `compass-tools-updated`, `DATABASE_URL`/`INTEGRATION_DATABASE_URL` unset) | Result |
|---|---|
| `vitest run --maxWorkers=2` | **281 files passed, 28 skipped (309); 3,882 tests passed, 569 skipped (4,451); 0 failed**; exit 0; 553 s |
| `tsc --noEmit` | exit 0, **0 errors** (24 s) |
| ESLint | **863 files, 0 errors, 0 warnings** (73 s) |
| `npm audit` | 70 vulnerabilities (2 critical, 22 high, 45 moderate, 1 low); production-only 61 (2/21/37/1); lockfile unchanged |
| Skipped = not passed | 569 tests / 28 files: 25 database-backed `__integration__` files, `scripts/__integration__/vercel-build.integration.test.ts` (5), `src/__tests__/deploy-image-version.test.ts` (15) and a few environment-gated cases; reasons are the missing disposable database and deploy-environment inputs |
| Not run | production build, browser tests of the CRM, authenticated UI, live website-to-CRM contract tests, any database-backed test, original CRM tests (reference only; its `.env` points at a non-loopback database) |

No flaky test was observed in the CRM run (single pass; flakiness over repeats was not measured).

## 9. Website ↔ CRM boundary (CRM side)
Payload contract matches field by field (see the website report §8): `flightInquiryBase` is `strict()`, every website field exists with compatible or looser limits, enums are identical, `submissionId` is refused in the body and accepted only as the `Idempotency-Key`, contact `subject` enums are identical, newsletter `{companyId,email,source}` matches. Findings that cross the boundary: **C8** (contract lives in an uncommitted merge), **C6** (no per-visitor limit; duplicate guard off), website **W2** (contact not idempotent). Variable names differ by design (website `CRM_API_KEY` ↔ CRM `WEBSITE_API_KEY`; website `CRM_COMPANY_ID` ↔ a real company id; `LEAD_INGEST_SECRET` must be identical). Live verification (lead + activity creation, duplicate and 409 behaviour, key rotation with `WEBSITE_API_KEY_NEXT`) is **blocked**: no staging CRM, no database, no credentials.

## 10. Remaining limitations
No database-backed verification; no authenticated UI review; no production build or standalone-build test; no performance or query profiling; no real-device testing; the original CRM's git repository is unusable and its state beyond HEAD is unknown; dependency triage of 70 advisories is incomplete (only `next`, `proxy-addr`, `body-parser`, `@prisma/config`, `@tiptap/core` were read in detail); the website's and CRM's idempotency/duplicate claims are source-level only.

## 11. Approvals needed (priority order)
1. **C8** — decide the fate of the uncommitted merge, the 79 staged entries and the stash (and whether to repair the original CRM's `.git/config`).
2. **C1** — approve the Next.js (≥ 16.4.6) and production-dependency upgrades.
3. **C2** — approve campaign-HTML sanitisation (adds a dependency) and a sandboxed preview.
4. **C3/C4** — approve minimal public health response and `poweredByHeader: false`.
5. **C6/C9/C5** — approve enabling the contact duplicate guard, the production default for the poller, and splitting the "process due" workers from their UI actions.
6. Approve a disposable PostgreSQL (when you decide) so C11 and the deferred suites can run.
7. Low items (C7, C10, C12, C14) as convenient.

## 12. Deferred database-dependent work
Database-backed integration tests (25 files + related, 569 tests skipped), Prisma migrations against a test database (the two new migrations remain unapplied), the sequence advisory-lock concurrency test, the six website-to-CRM contract tests, database-backed browser flows. **None passed and none was attempted;** no PostgreSQL was installed; no Neon/Aiven was configured; the database guard and its loopback restriction were not changed.

## 13. Implementation and verification - 2026-11-13 (added after the audit above; the audit text is unchanged)

Working-tree changes only, in `compass-tools-updated`; nothing staged, committed, stashed or merged (the unfinished merge, its 79 staged entries and the
stash are exactly as found); no production, database or credential was touched. Full summary and test totals: the website's
`docs/IMPLEMENTATION_SUMMARY_2026-11-13.md`. Final CRM totals: `tsc` 0 errors, ESLint 0 problems, vitest **3,990 passed / 0 failed / 554 skipped**
(the skipped are the database-integration suites), `npm run build` exit 0.

| Finding | Outcome | Change |
|---|---|---|
| C1 Next.js advisories | **Fixed** (smallest same-line patched release; re-checked, not assumed) | `next` and `eslint-config-next` 16.3.8 -> 16.4.6 (exact pins kept); `nodemailer` 9.0.5 -> 10.1.4 (14 advisories; major, one call site, tests green); `zod` -> 4.6.6; Tiptap 3.30.2 -> 3.34.0 together with ProseMirror 1.42.9 (they pin each other; paste-XSS fix); new `sanitize-html` 2.18.1 (2.17.x is itself flagged). `npm audit`: 71 -> 38 findings, critical 2 -> 1 (`proxy-addr`, via the `shadcn` CLI chain). No `npm audit fix --force`. The 38 left are the Cloudflare Workers build chain, the Prisma CLI chain (Prisma 8 is an RC), the `shadcn` CLI chain and test tooling - listed in the summary with the recommended next step. |
| C2 Campaign HTML XSS | **Fixed** | `src/server/email/sanitize-campaign-html.ts` (allow-list, parser-based) applied at save, in a new `previewCampaignHtml` action behind a sandboxed iframe (replaces both `dangerouslySetInnerHTML` uses), and inside `buildMarketingCampaignEmail`. Legacy rows are not rewritten. 57 sanitizer tests + 5 lifecycle tests. `cid:` images are deliberately not allowed (the CRM attaches nothing inline). |
| C3 `/api/health` disclosure | **Fixed** | Anonymous: `{status}` + HTTP code. Detail only with `Authorization: Bearer <CRON_SECRET>`; `deploy/verify.sh` and `deploy/ci-smoke.sh` send it from inside the container; the Docker healthcheck needs only the status and is unchanged. |
| C4 `X-Powered-By` | **Fixed in config and tests**; live response **not observed** | `poweredByHeader: false`; built `required-server-files.json` confirms it. The 3001 dev server must be restarted (it answers 500 after the dependency update) before a live header check. |
| C5 "Process due" actions | **Partially confirmed, fixed minimally** | Both sweeps moved verbatim to non-action modules; the two buttons call role-checked wrappers (`canViewTasks`, `canViewSequencesPage`); cron routes and the poller call the sweeps directly. Existing concurrency suites now target the sweeps. |
| C6 Rate-limit fail-open | **Not confirmed as a defect**; no change | The authenticated website API budget is fail-closed; the failed-auth counter and the public per-IP limiter fail open (documented), the latter only without `TRUSTED_PROXY`, which `compose.yaml` sets. |
| C9 Production poller | **Confirmed as designed; default unchanged** | The VPS documents reliance on it. Added opt-out `DISABLE_IN_PROCESS_POLLER=true` (`.env.example`); overlap with an external scheduler is safe (atomic claims). |
| W2 (CRM half) | **Implemented, mocked-DB tested only** | Optional `submissionId` on `/api/public/contact-inquiry` (derived primary key + advisory lock; `duplicate:true`, `409` on key reuse; no schema change). Needs the deferred DB suite to prove the lock and key. |
| C7, C10, C11, C12, C14, C15, C16, C8 | **Not changed** | Recommendations stand. C14's code moved unchanged into `due-task-notifications.ts`. C11 remains blocked on the disposable database. |

Also found: the original `compass-tools/.git/config` has been zero-filled since 2026-10-21 (git there fails with "bad config line 1"); not touched.
