# Four-project comparison, parity verification and security review — 2026-11-13

Scope: `compass-tools` (original CRM) vs `compass-tools-updated`, and `Travel Agency Website` (original) vs `Travel Agency Website-updated`.
Read-only on both originals. Evidence below was produced by the commands listed in section H. Nothing here was committed, staged or deployed.

## A. Executive summary

* **Website parity: complete.** All 22 routes (pages + API + metadata routes) exist in both; the 14 `public/` files and all 17 image/icon/font files are
  byte-identical; the 210 external image URLs are identical (212 reachable). Every original-only source file is part of the intentionally removed direct-database layer.
* **CRM parity: complete.** All 63 routes exist in both; 434 of 435 original source files exist in the updated CRM and **no exported symbol was lost**; the only missing file
  is the original's `src/test/disposable-database.ts` (an approval item, section I). All 74 original migrations are present, plus two additive ones.
* The original CRM contains eight files with NUL-corrupted content; the updated CRM has intact versions of seven of them (the eighth, `src/test/__tests__/disposable-database.test.ts`, belongs to the approval item in section I-3).
* **One confirmed vulnerability found and fixed** (unbounded request bodies on three unauthenticated CRM endpoints — measured before and after).
* **Security items still open:** `next` 16.3.8 (critical advisories), `nodemailer`/`zod` advisories, a public `/api/health` that discloses configuration posture,
  `X-Powered-By`, no server-side sanitising of stored campaign HTML. Fixes for the first two need approval; the others touch files that are part of the staged merge.
* **Blocked:** everything that needs a disposable PostgreSQL (CRM integration tests, advisory-lock concurrency, migrations, live website-to-CRM contract tests, DB-backed browser flows).

## B. Website comparison

### Route inventory (22 = 22, none original-only, none updated-only)

Home `/`, `/about`, `/blog`, `/blog/[slug]` (36 articles), `/business-class`, `/contact`, `/cookie-policy`, `/destinations`, `/destinations/[region]/[country]/[city]` (171),
`/flights`, `/how-it-works`, `/privacy-policy`, `/terms-of-service`, `/api/health`, `sitemap.xml`, `robots.txt`, `manifest.webmanifest`, `opengraph-image`, `twitter-image`, icons, `/_not-found`.
Status: PRESENT for all; UPDATED where the source differs (44 source files, all intentional — listed below).
A live crawl of the production build found **218 sitemap URLs, 218 × HTTP 200, 0 redirects**; 60 of 223 distinct `/_next/image` URLs sampled, all served as images.

### Intentional differences (evidence = source diff)

| Area | Change |
| --- | --- |
| Architecture | Removed: `prisma/`, `src/generated/prisma`, `src/lib/{prisma,db-error,db-tls,schema-guard,readiness-cache,migration-bundle.generated,schema-shape.generated}.ts`, `src/server/{contact,create-website-lead,crm-company,lead-distribution,save-submission-info,schema-ready}.ts`, `src/lib/submission-id.ts`, runtime-role SQL/scripts, `vercel-build`. Replaced by `src/lib/crm-api/*`, `src/server/crm-api.ts` (API-only; a structural test asserts no DB code, no DB packages, no DB env). |
| Behaviour kept | Flight request → CRM `POST /api/v1/website/flight-inquiries` (Bearer key, Idempotency-Key = the form's submission id, signed visitor context). Contact → `/api/public/contact-inquiry`. Newsletter → `/api/public/subscribe`. Lead distribution moved to the CRM. |
| Contact details | Phone `+1 415 570 9267`, `info@businessflights.travel`, `350 Sansome St, San Francisco, CA 94104`. The old address/e-mail appear only inside a test asserting they are absent. |
| UX / a11y | Unique ids for the two newsletter forms, `autocomplete`, `role="alert"` errors, focus-to-first-error, return-date clearing, calendar range highlight, consent notice, list semantics, stock-photo alt text, non-misleading Trustpilot icon (no five stars). |
| Structured data | `@id`-linked Organization/WebSite/Article (`src/lib/json-ld.ts`). |

### Assets and images

| Measure | Original | Updated |
| --- | --- | --- |
| `public/` files | 14 (0.95 MB) | 14 (0.95 MB), **all identical (SHA-256)** |
| Image/icon/font files in the whole tree | 17 | 17, **all identical** |
| External image URLs referenced (Unsplash) | 210 | 210 (identical set) |
| Local image references that fail to resolve | — | 0 (15 checked) |
| Unsplash photos reachable | — | 212 / 212 |

Dimensions (unchanged): `logo.png` 1163×488, `brand/logo-navy.png` and `logo-white.png` 1077×402, `logo-mark-b.png` 116×132, `icon-192.png` 192×192, `icon.png` 128, `apple-icon.png` 180, airline logos 128×128.
`next/image` is in use on 14 places (13 with `sizes`), hero images carry `priority`/`fetchPriority=high`, the rest lazy-load; `/_next/image` answers with `Cache-Control: public, max-age=14400`.
No image was replaced, recompressed or removed. **Why the updated folder is smaller (26.8 MB → 6.0 MB, excluding `node_modules`/`.next`/`.git`):** 783 `.agents/` skill files, 82 `.claude/`, 9 `.windsurf/`, 57 `prisma/` files (schema + 56 migrations), 61 `src/` files (generated Prisma client + DB layer), 17 `tests/` for the DB layer — none are site content.

### Caching and headers (measured on the running production build)

| Route | Cache-Control |
| --- | --- |
| Static pages (`/`, `/contact`, destinations …) | `s-maxage=31536000` + ETag (shared caches only; browsers revalidate) |
| `/flights` (reads `?to=`), 404 pages | `private, no-cache, no-store, max-age=0, must-revalidate` |
| `/api/health` | `no-store` (body is only `{"status":"ok"}`) |
| `sitemap.xml`, `robots.txt` | `public, max-age=0, must-revalidate` |

No `Set-Cookie` on any page; nothing personalised is publicly cacheable. All pages carry CSP, HSTS, `nosniff`, frame-deny, Referrer-Policy and Permissions-Policy.

### Performance finding (not changed)

JS per page 690–862 KB raw (217–262 KB gzip); ≈118 KB raw / ≈35 KB gzip of phone-number code (`libphonenumber-js/min`) ships on `/`, `/contact`, `/flights` because `FlightRequestForm` and `ContactForm`
statically import `isValidPhoneNumber`. The server actions validate again, so a lazy client check is possible, but it makes `validate()` asynchronous in conversion-critical forms.
Left unchanged: the proof requirement (identical behaviour under browser tests) was not met for a change that I was not asked to approve. Proposed approach and expected effect are in section I.

## C. CRM comparison

* **Routes:** 63 = 63 (none original-only, none updated-only); `public/` 8 = 8 (`_headers` differs only in line endings).
* **Source files:** 435 original, 434 present; **0 exports removed**, 21 added. Missing: `src/test/disposable-database.ts` (+ its test).
* **Updated-only (39 src files):** geolocation (`server/geo/*`), bulk selection, sequence enrollment eligibility / enroll-by-status, active-sequence components, inquiry submission info (this task), range-date fields, note meta.
* **Schema:** additive only — `Account.lastSignInLocationSource/At`, `InquirySubmissionInfo` (+ relation on `ContactInquiry`), `LeadIngestFingerprint` moved within the file. Migrations 74 original + `20261108000100_sign_in_location_provenance` + `20261113000100_inquiry_submission_info` (**not applied anywhere**).
* **Permissions:** new `canBulkDeleteLeadsAndContacts` (Admin only), `canBulkEnrollInSequence` (= `canManageSequences` ∧ list access); no existing predicate weakened.
* **Intentional removals:** the previous-period percentage comparison on Commissions and Salesboard (documented in `docs/UPDATED_PROJECT.md` and in the component comment).
* **Original defects the update repairs:** 7 of 8 files containing NUL bytes (`customer-theme-provider.tsx`, `reveal.tsx`, `sequence-variables.ts`, `account-visibility.test.ts`, `lead-intake.ts`, `reference-data.test.ts`, `disposable-database.test.ts`, `docs/WEBSITE_LEAD_API.md`) and an unreadable `.git/config`; two zero-byte stray files (`client`, `server`) exist only in the original.
* **Build artefacts:** `data/geoip/city.mmdb` (≈125 MB, git-ignored) is why the updated folder is larger.

## D. Targeted changes checklist

| Requirement | Project | Status | Evidence | Tests | Remaining |
| --- | --- | --- | --- | --- | --- |
| Failed enrollment never ACTIVE; bounded retry; duplicates; Gmail preflight; worker re-check before send | CRM | IMPLEMENTED BUT NOT FULLY VERIFIED | `server/actions/sequences.ts`, `sequence-enrollment-eligibility.ts`, `gmail-send.ts` | 43 unit tests | DB-level behaviour BLOCKED |
| Concurrent-enrollment advisory lock | CRM | BLOCKED | `pg_advisory_xact_lock(hashtextextended(…))` in code | none can run | needs disposable PostgreSQL |
| Lead-profile active-sequence notice, Unenroll (server-side auth, audit) | CRM | IMPLEMENTED BUT NOT FULLY VERIFIED | `components/leads/*`, `unenrollLead` | 9 component + action tests | browser/DB run BLOCKED |
| Enroll Leads by status (preview, confirm, revalidate, batches) | CRM | IMPLEMENTED BUT NOT FULLY VERIFIED | `sequence-status-enroll.ts`, `enroll-leads-dialog.tsx` | 16 + 9 tests | BLOCKED as above |
| IP/location: sign-in, booking, flight lead, CRM inquiry | CRM | IMPLEMENTED BUT NOT FULLY VERIFIED | trusted path only; local DB-IP fallback; latest-only sign-in; Admin-only; no lat/long | spoof/IPv4/IPv6/private/mapped/failure tests | stored rows BLOCKED |
| Business Flights "Get In Touch" IP | CRM + website | PARTIALLY IMPLEMENTED | CRM accepts a signed visitor context; the website contact action does not send one | 14 builder + 8 route tests | website change needs approval |
| Airport/airline integrity | CRM | COMPLETE AND VERIFIED (static data) | recomputed: 9,052 airports (7,814 ICAO), 5,817 airlines (1,110 IATA); no duplicate IATA, no duplicate ICAO among code-less airlines | airport + airline integrity tests | seeding on a real DB BLOCKED |
| Airline confirmation e-mail mapping | CRM | IMPLEMENTED BUT NOT FULLY VERIFIED | `airline-confirmation-recipients.ts` | unit tests | integration BLOCKED |
| Two inquiry systems separate | CRM | COMPLETE AND VERIFIED (code + unit) | own routes/sources/inboxes/rate limits; `source` fixed by route | route tests | DB BLOCKED |
| Website API-only + CRM client | website | COMPLETE AND VERIFIED against a stand-in CRM | structural guards | 40 client tests | live contract (6) BLOCKED |
| Website UI behaviour | website | COMPLETE AND VERIFIED | Playwright | 308 (desktop) + 924 (mobile) passed | see Section H |
| Security: cron, headers, CSP, uploads probe, sessions | CRM | COMPLETE AND VERIFIED (static + probes) | section F | existing + new tests | — |
| Performance: phone code | website | NOT CHANGED (documented) | measured | — | optional, section I |

## E. Asset inventory — see section B.

## F. Security findings

| Finding | Project | Severity | Status | Evidence | Correction / action |
| --- | --- | --- | --- | --- | --- |
| Unauthenticated JSON endpoints buffered unlimited bodies (`/api/public/{contact-inquiry,crm-inquiry,lead-capture,subscribe}`) | CRM | Medium (availability) | **CONFIRMED, FIXED** | before: 30 MB body fully parsed, HTTP 400 after 2.6 s; after: HTTP 413 in 0.1–0.3 s on all four | `server/security/read-limited-json.ts` (64 KB, declared length + counted stream); 18 regression tests |
| `next` 16.3.8 — critical advisories (image-optimizer SVG RCE, `use cache` RCE, server-action DoS; fixed 16.4.6) | CRM | Critical (in range) | CONFIRMED in lockfile; exploit preconditions not present (no `use cache`, no `next/image`, no SVG optimisation) | `npm audit` | **approval required** (section I-1) |
| `nodemailer` 9.0.5 (address-parser/DoS/recipient-domain advisories) | CRM | High/Moderate | CONFIRMED in lockfile; used only through `MailComposer` in `gmail-send.ts` | `npm audit` | approval required |
| `zod` 4.4.3 (memory exhaustion on large collections) | CRM | High | CONFIRMED in lockfile; now mitigated at the edge by the new body cap | `npm audit` | approval required |
| `@tiptap/*` / `prosemirror-view` (XSS on paste, ReDoS) | CRM | High/Moderate | CONFIRMED in lockfile (rich-text campaign editor) | `npm audit` | approval required; dependency |
| shadcn / opennext / wrangler tooling chains (61 advisories total, mostly build tooling) | CRM | various | CONFIRMED; not on the request path | `npm audit` | review with item above |
| Public `/api/health` returns configuration posture (card-vault state and key label, DB TLS mode, signer-IP capture, website-API configured, environment) | CRM | Low–Medium (reconnaissance) | CONFIRMED | `curl /api/health` | `src/lib/health-check.ts` is part of the staged merge → **not edited**; proposal: keep `{status}` public, move detail behind Admin or a secret header |
| `X-Powered-By: Next.js` on the CRM | CRM | Informational | CONFIRMED | response headers | `next.config.ts` is staged → **not edited**; set `poweredByHeader: false` (the website already does) |
| Stored campaign HTML rendered with `dangerouslySetInnerHTML` without server-side sanitising | CRM | Low (mitigated: CRM pages use a nonce CSP without `unsafe-inline`; authors are staff) | THEORETICAL / defence in depth | `campaign-form.tsx` | add an allow-list sanitiser at save (needs a dependency → approval) |
| Server actions `listLeadEligibleAgents(companyId)` / `listTaskEligibleAgents(companyId)` live in a `"use server"` file and trust the caller's `companyId`; `distributeNewWebsiteLead(leadId)` / `distributePendingWebsiteLeads()` carry no actor check | CRM | Low | THEORETICAL — unauthenticated and forged-cookie action POSTs are redirected to `/login` (probed, HTTP 307, fail-closed even with the DB down); reaching them needs an authenticated session plus another tenant's id | probe | not changed; proposal: derive company from the session / move internals out of the `"use server"` module |
| Lead IP Reveal is not Admin-only: Admin, or Manager/Ticketing **with the explicit booking-IP grant**, 15-minute recent sign-in, audited | CRM | Policy | DISCREPANCY with "full IP restricted to administrators" | `canRevealBookingIp` | business decision; inquiry Reveal is Admin-only |
| Signed visitor context has a 5-minute window and no nonce (replay re-sends the same IP) | CRM | Informational | THEORETICAL | `lead-ingest-context.ts` | accepted |
| Cron routes | CRM | — | PASS: 503 without `CRON_SECRET` in production, constant-time bearer check | probed | — |
| Website API without a key | CRM | — | PASS: 503 `not_configured`; flight API body cap 32 KB | probed | — |
| Attachments | CRM | — | PASS: 401 without session; storage never served statically; health probe does not write or leak paths | probed + code | — |
| OAuth (Gmail) | CRM | — | PASS: `state` cookie checked, fixed redirect base, identity from the session | code | — |
| Secrets in client bundles / tracked env files | both | — | PASS: none (only `.env.example` files are tracked) | grep of `.next/static` | — |
| Website | website | — | PASS: `npm audit --omit=dev` 0; dev-only toolchain: 7 moderate (`minimatch` via typescript-eslint); health endpoint minimal; CSP/HSTS present; no cookies | audit + probes | — |

Not testable here (marked NOT TESTED): CSRF behaviour of authenticated actions beyond Next's built-in origin check, cross-tenant behaviour of every query against real data, file-upload content validation against a real store.

## G. Bugs and improvements

| Issue | Root cause | Files | Fix | Regression test | Result |
| --- | --- | --- | --- | --- | --- |
| Unbounded public request bodies | `Request.json()` buffers everything | `server/public-inquiry.ts`, `app/api/public/{lead-capture,subscribe}/route.ts`, new `server/security/read-limited-json.ts` | bounded reader, 413 | `read-limited-json.test.ts`, `public-endpoints-body-limit.test.ts` | PASS (18) and re-measured live |
| Bookings and flight leads had no location when the platform sent none | location only from Vercel headers | `security/ip-capture.ts`, `lead-submission-info.ts` | local DB-IP fallback | `ip-capture.test.ts`, `lead-submission-info-local-geo.test.ts` | PASS |
| Inquiries recorded no IP/location | no table | schema + migration + `inquiry-submission-info.ts` | new table, masked + audited Reveal | 39 tests (builder 14, routes 8, reveal 7, query 4, component 6) | PASS (DB part BLOCKED) |

No other defect was reproduced. Recorded but not fixed: the issues in section F marked "not edited".

## H. Test results

| Command (project) | Result |
| --- | --- |
| `npx tsc --noEmit -p .` (CRM) | PASS |
| `npx eslint .` (CRM) | PASS |
| `npx prisma validate` (CRM) | PASS |
| `npx vitest run --maxWorkers=3` (CRM) | PASS — 280 files / **3,820 passed**, 28 files / **569 skipped** (database-gated; **not passes**) |
| `npm run build` (CRM, throw-away DB URL, no network DB) | PASS |
| `npx tsc --noEmit`, `npx eslint` (website) | PASS |
| `npm run build` (website) | PASS |
| `npm run validate:content` (website) | PASS (36 articles, 171 destinations) |
| `npm run validate:seo` against the production build (website) | PASS — 218 routes, 0 failures |
| `npx playwright test --project="Desktop Chrome" --workers=2` (website, production build, no CRM configured) | PASS — **308 passed, 2 skipped** |
| `npx playwright test --project="Mobile 320" --project="Mobile 375" --project="Mobile 390"` | PASS — **924 passed, 6 skipped** |
| `npx playwright test --project=Infrastructure --no-deps tests/crm-api-client.spec.ts tests/crm-api-actions-e2e.spec.ts` | PASS — 40 passed, 19 skipped |
| `npm audit --omit=dev` (CRM) | FAIL — 61 advisories (2 critical, 21 high); (website) PASS 0 |
| `bash -n` on 13 + 5 shell scripts | PASS |
| `compose.yaml` parse (both; `docker` not installed) | PASS as YAML, no service publishes a host port; `docker compose config` NOT TESTED |
| Lighthouse | NOT TESTED |
| CRM integration tests (25 files), advisory-lock concurrency, migration application, live website→CRM contract (6 tests), DB-backed browser flows | BLOCKED (no authorised disposable database) |
| Live Cloudflare/tunnel/DNS, production image, secret consistency | NOT TESTED (no access) |

Live-contract prerequisites (`tests/crm-contract-live.spec.ts`): a non-production CRM with a disposable database and migrations, its throwaway `WEBSITE_API_KEY`, then
`CRM_CONTRACT_URL=http://127.0.0.1:<port>` and `CRM_CONTRACT_KEY=<that key>` (plus `CRM_CONTRACT_ALLOW_REMOTE=staging` only for a non-loopback, non-production target). The suite creates leads marked `CONTRACT-CHECK` at `@example.test`.

## I. Approval proposals (each independent)

1. **Dependency upgrade (CRM).** `next` 16.3.8 → 16.4.6 (same minor line the website already runs, 16.4.2; peer range includes React 19), `eslint-config-next` to the same version; separately `nodemailer` ^9.0.5 → ^10.x (only `MailComposer` is used; the website runs 10.2.1) and `zod` → ≥4.6.6. Files: `package.json`, `package-lock.json` only. Risks: Next 16.3→16.4 behaviour changes (this repo's `AGENTS.md` warns about them), OpenNext/Cloudflare adapter compatibility (`@opennextjs/cloudflare` 1.20.10 is pinned), MailComposer output. Verify with tsc, eslint, vitest, build and the proxy/Server-Action probes.
2. **Website contact-form IP.** Three small edits: `src/lib/crm-api/config.ts` (read `LEAD_INGEST_SECRET` for the `public-inquiry` target as well), `src/lib/crm-api/client.ts` (let `postPublic`/`postContactInquiry` accept extra headers), `src/server/actions/submit-contact-message.ts` (call `captureSubmissionInfo(headerList)` and pass `buildVisitorContextHeaders(info, api.config.ingestSecret)`), plus tests. Security: only values this server observed on the trusted path are signed; the CRM ignores anything unverifiable; no client-supplied IP is used. Privacy: `privacy-policy/page.tsx` line ~61 says the server records the IP "when you submit a flight request" — the contact form is not mentioned, so **legal review of the wording is needed first**.
3. **Adopt the original CRM's disposable-database guard.** Current gate: tests run only if `INTEGRATION_DATABASE_URL` is set and then set `DATABASE_URL` to it — **any** URL is accepted. Original guard: loopback literal (`127.0.0.1`/`[::1]`), explicit port and user, database name exactly `compass_test`, only `sslmode=require|verify-ca|verify-full`, no whitespace/fragment, refuses if a Prisma client already exists, restores `DATABASE_URL` afterwards. It prevents a remote or production URL being used by mistake; it does not prove a loopback port is not a tunnel. Compatible with the CI database (`127.0.0.1:5432/compass_test?sslmode=require`); **incompatible** with `INTEGRATION_ADMIN_DATABASE_URL` (database `postgres`), so the schema-initialisation tests would need an explicit exception. Minimal change: copy `src/test/disposable-database.ts` and its test, call it from the 25 integration files' setup.
4. **Provision a disposable PostgreSQL** (local loopback, database `compass_test`), then run the 25 integration files, the advisory-lock test, migration application and the 6 live-contract tests.
5. **Health endpoint and `poweredByHeader`:** edit staged files `src/lib/health-check.ts` / `next.config.ts` (or confirm editing them as separate unstaged changes).
6. **Lazy phone validation (website):** dynamic-import `@/lib/phone` on first interaction/submit; expected −118 KB raw / −35 KB gzip on `/`, `/contact`, `/flights`; must be proven with the browser suite and a before/after measurement.
7. **Lead IP Reveal policy:** keep (Admin + granted Manager/Ticketing) or make Admin-only.
8. **Legal/privacy wording**, **Cloudflare/DNS/tunnel**, **migrations on live environments**: not touched.

### Operator checklist (Cloudflare / tunnel / origin) — not verified, for the operator

* Cache rules: HTML is `s-maxage=31536000` — after every deploy purge the zone (or use cache tags); never cache `/flights` (private/no-store) or `/api/*`; respect origin `Cache-Control` for `/_next/image`; do not cache `/_next/data` or any response with `Set-Cookie`.
* Tunnel lock-down: neither compose file publishes host ports; the origin must be reachable only from `cloudflared`; disable any public hostname that points directly at the origin; allow only the intended hostnames in the tunnel config.
* TLS: Full (strict) to the origin where TLS is used; HSTS is sent by both apps; keep `DATABASE_SSL_MODE=disable` only for the private compose network.
* CRM private network: the website must reach `/api/v1/website/flight-inquiries` over the private network; the public hostname must answer 404/403 for it. `TRUSTED_PROXY=cloudflare` only when the CRM is reachable solely through Cloudflare.
* Secrets: `CRM_API_KEY` (website) must equal `WEBSITE_API_KEY` (CRM); `LEAD_INGEST_SECRET` identical on both sides and ≥ 32 characters; `CRON_SECRET` set; production `CARD_VAULT_MODE` decision.
* Verify the running image matches the reviewed commit before relying on any result here.

## J. Files changed in this task (CRM, unstaged)

New: `src/server/security/read-limited-json.ts`, `src/server/security/__tests__/read-limited-json.test.ts`, `src/server/__tests__/public-endpoints-body-limit.test.ts`, this document.
Modified (not in the staged set): `src/app/api/public/lead-capture/route.ts`, `src/app/api/public/subscribe/route.ts`, `src/server/public-inquiry.ts`.
Website: no file changed. Both originals are byte-identical to the saved baseline (1,378 and 1,122 files).
Earlier in the same working session (previous request, already reported): inquiry IP/location, booking/lead local-geolocation fallback, airport integrity test, sequence/enrollment work, `docs/GEOIP.md` §5a.

## K. Git integrity

CRM: branch `work/commission-salesboard-notes-ui`, HEAD `5a77976`, `MERGE_HEAD` `c6b8d8e` (merge still unfinished), index SHA-256 `3422053116FF…49BEC` and `git ls-files -s` identical to the baseline; 166 status entries (the staged set is unchanged; the rest are unstaged/untracked).
Website-updated: branch `work/website-crm-api-integration`, HEAD `d1d1b61`, index unchanged, 15 entries (unchanged).
No commit, push, branch, stage, reset, restore, stash, clean, rebase, cherry-pick or merge operation was run. Only four project folders exist in the workspace.

## L. Readiness

1. Updated website — **COMPLETE WITH DOCUMENTED LIMITATIONS** (parity verified; contact-form IP, phone-bundle size and live Cloudflare checks remain).
2. Updated CRM — **BLOCKED ON EXTERNAL REQUIREMENTS** (database-backed verification; `next`/`nodemailer`/`zod` upgrade decision).
3. Website-to-CRM integration — **BLOCKED ON EXTERNAL REQUIREMENTS** (client verified against a stand-in; live contract needs a disposable CRM).
4. Overall four-project comparison — **COMPLETE WITH DOCUMENTED LIMITATIONS**.


---

# Addendum — 2026-11-14: disposable-database guard, database-backed validation, lazy-loaded phone validation

Scope of this addendum: the work approved after the report above. Nothing was committed, staged, deployed or applied to any database. Where something could not be done it says so, and nothing marked BLOCKED or NOT RUN is a pass.

## 1. Disposable PostgreSQL — NOT CREATED (blocked: no PostgreSQL on this machine)

Inspection before creating anything:

| Check | Result |
| --- | --- |
| Windows services named `*postgres*` | none |
| `psql`, `pg_ctl`, `initdb`, `postgres` on PATH | none |
| `C:\Program Files\PostgreSQL`, `C:\Program Files (x86)\PostgreSQL`, any `*pgsql*`/`*postgres*` folder | none |
| Anything listening on 5432–5440, 54329, 54330 | nothing |
| Docker / Podman | not installed |
| WSL | `wsl.exe` exists, no distribution listed |
| Existing databases | none to inspect, so none were touched |

`@electric-sql/pglite` is in the CRM's `node_modules`, but it is an in-process WebAssembly engine, not a PostgreSQL server: it has no loopback listener and no TLS (the app's `prisma.ts` requires TLS unless `DATABASE_SSL_MODE=disable`), and a single connection cannot exercise the advisory-lock concurrency test. It was therefore not used. Per the instruction ("stop and report what is missing rather than improvising") no database was created and no software was installed.

**What is missing:** a local PostgreSQL server (any 14+ release) that listens only on `127.0.0.1` (or `[::1]`), with TLS enabled (self-signed is fine), a role with `CREATEDB`, and an empty database named exactly `compass_test` plus the maintenance database `postgres` on the same host and port. Two ways forward (decision in section 11): you install one, or you approve my installing a portable server through the `embedded-postgres` npm package inside this session's own scratch directory (outside the workspace), which is how earlier sessions did it.

## 2. Strict disposable-database guard — IMPLEMENTED and REGRESSION-TESTED (not yet exercised against a real server)

Reference: the original CRM's `src/test/disposable-database.ts` (read-only). Its companion test file in the original is entirely NUL bytes, so the regression tests were written new.

| File (CRM, all new/unstaged except `vitest.config.ts`, which is tracked and unmodified-in-the-index) | Purpose |
| --- | --- |
| `src/test/disposable-database.ts` | The original guard, refactored so both URLs share one syntax check (`parseLoopbackUrl`), plus the admin exception and one new rule: the URL must contain exactly one `@` (an extra `@` makes the host ambiguous between parsers). |
| `src/test/integration-database-guard.ts` | Vitest **globalSetup**: static check, then a live check — connects once and requires the server to report database `compass_test` and a loopback address (or a local socket). Anything else, or "cannot verify", aborts the whole run. |
| `vitest.config.ts` | `globalSetup: ["./src/test/integration-database-guard.ts"]` |
| `src/test/__tests__/disposable-database.test.ts` | 62 regression tests (30+ rejected spellings) |

Why a global setup rather than editing the 26 gated test files: two of them (`lead-attachments.integration.test.ts`, `system-health.integration.test.ts`) are part of the staged merge, and the instruction is to stop rather than modify a staged file. A global gate covers every file, including those, without touching any of them.

Rules enforced (`INTEGRATION_DATABASE_URL`): scheme `postgres(ql)://`; host exactly `127.0.0.1` or `[::1]` (not `localhost`, `0.0.0.0`, `127.1`, decimal/hex spellings); explicit port; explicit user; exactly one `@`; no fragment, no empty `?`, no whitespace/control characters; query empty or exactly one `sslmode` of `require`/`verify-ca`/`verify-full` (`disable`/`allow`/`prefer`, duplicates, `host=`, `hostaddr=`, `dbname=`, `options=` all refused); database exactly `compass_test` (case-sensitive; `production`, `postgres`, `compass_tools_test`, `compass_test_2` refused). An ambient `DATABASE_URL` (including a `.env` one) never activates anything. Error messages name the broken rule only — never the URL, host, user, password or database.

**The admin exception** (`INTEGRATION_ADMIN_DATABASE_URL`). It is required by exactly one test, `scripts/__integration__/vercel-build.integration.test.ts`, which connects to the maintenance database to `CREATE`/`DROP` its own `recovery_it_<timestamp>` databases. It is accepted only if all of these hold: `INTEGRATION_DATABASE_URL` is also configured and approved; every rule above applies; the database is exactly `postgres`; and host **and** port equal the approved URL's (the same local server). It grants nothing for any other server. Caveat: the admin credentials can touch every database on that server, so that server must hold only disposable databases. The CI settings (`127.0.0.1:5432/compass_test?sslmode=require` and `.../postgres?sslmode=require`) satisfy the guard.

Results:

| Check | Result |
| --- | --- |
| `npx vitest run src/test` | PASS — 62 / 62 (accepted URLs, 30+ rejected spellings, admin accepted/rejected, live verification with a fake client incl. wrong database, non-loopback answer, unreachable server, connection always closed, error text never repeats host/user) |
| End to end, remote URL (`INTEGRATION_DATABASE_URL=postgresql://…@db.example.com:5432/production`) | PASS (fail-closed) — run aborted before any test file loaded: "refused: the host must be exactly 127.0.0.1 or [::1]" |
| End to end, approved URL with nothing listening (`127.0.0.1:54329/compass_test`) | PASS (fail-closed) — aborted: "the target database could not be verified … Nothing was run." |
| End to end, only an ambient remote `DATABASE_URL` | PASS — nothing activated; the integration file reported 35 skipped |
| Guard against a real, running server | NOT RUN (no server) |

## 3–5. Database-backed validation — BLOCKED (not run, not passed)

| Item | Status | Reason |
| --- | --- | --- |
| 25 `*.integration.test.ts` files + `reference-data.test.ts` (569 tests) | BLOCKED | no disposable database |
| Sequence advisory-lock concurrency test | BLOCKED | needs a real server with several connections |
| `scripts/__integration__/vercel-build.integration.test.ts` (migrations from scratch) | BLOCKED | needs the admin URL on a real server |
| Validation of the two new migrations (`20261108000100_sign_in_location_provenance`, `20261113000100_inquiry_submission_info`) | BLOCKED — **static checks only**: `prisma validate` PASS, the migration SQL was compared with Prisma's own generated SQL earlier (identical), manifest regenerated; **never applied** | no database |
| Website→CRM live contract tests (6) | BLOCKED | need the CRM above, a throwaway `WEBSITE_API_KEY`, `CRM_CONTRACT_URL`, `CRM_CONTRACT_KEY`. The 40 stand-in tests pass; they are not the live contract |
| Database-backed browser flows | BLOCKED | need the CRM above |

Totals for the CRM no-database suite after this work: **281 files passed, 28 skipped; 3,882 tests passed, 569 skipped** (`npx vitest run --maxWorkers=3`); `tsc` and `eslint .` clean.

## 6. Phone-validation lazy loading — IMPLEMENTED (website)

Finding behind it: before the change, `libphonenumber-js/min` and its metadata (chunk `34lcb02tjbpk6.js`, 118.6 KB raw / ≈30 KB gzip) was referenced by the HTML of `/`, `/contact` and `/flights`, because `FlightRequestForm` and `ContactForm` statically imported `isValidPhoneNumber`.

What changed:

* `src/lib/phone-validator.ts` (new): the only thing the forms import now (≈1 KB). `loadPhoneValidator()` does one dynamic `import("@/lib/phone")`, never rejects (resolves `null` on failure, retried next time); `getPhoneValidatorState()` is synchronous once loaded.
* `PhoneNumberField.tsx`: warms the validator on first focus / pointer-down / touch-start (capture handlers, so the input's own events are untouched) and when a value appears (autofill/paste).
* `ContactForm.tsx`, `FlightRequestForm.tsx`: `validateClientSide(isValidPhone)`; `handleSubmit` runs **synchronously, exactly as before, whenever the validator is loaded** (the normal case). If a submit arrives before it is (autofill, very fast keyboard submit) the form waits for the chunk once (guarded by a ref, behind the existing double-submit guard) and re-submits itself with the latest field values, so the same checks and messages run. If the chunk cannot be loaded at all, the client-side format check is skipped for that submission and the server action — which has always re-validated with the same library and the same message — decides; "required" is still checked on the client.
* Unchanged: the messages, `aria-invalid`/`aria-describedby` wiring, the rich country-select input and its existing load-on-mount behaviour, international numbers, the submit payloads, the idempotency key, the honeypot.

**An honest result about what this can and cannot save.** The same metadata is needed by the rich phone input (`react-phone-number-input`), which the page has always loaded right after hydration, and that chunk shares the module. So the 118 KB is now fetched *after* hydration instead of *in the HTML*, together with the rich input's own chunk, and total JavaScript once the page has settled is unchanged (+0.4 KB gzip: the new 1 KB wrapper). Touching the field then loads only the 1 KB wrapper (verified). What improved is the critical path: 118 KB raw / ≈30 KB gzip left the initial script set, hydration no longer parses it, and main-thread blocking dropped on the slow profile. Saving the bytes outright for visitors who never use the form would require deferring the rich input itself to first interaction; that swaps the input element under the visitor's finger (focus and keyboard loss on phones) and was **not** done (decision in section 11).

Regression tests (website): new `tests/phone-validation-loading.spec.ts` — 14 tests × 4 viewport projects: the HTML of all three routes carries no phone metadata; touching the field loads one small chunk; incomplete number → same message, `aria-invalid`, `aria-describedby`; "required"; a UK number accepted; Enter inside the field validates; a submit before the library has loaded waits and then validates identically (and a rapid second submit does not queue another wait); a valid number submitted early is accepted; a library that cannot load leaves the form responsive and the server answers; the same for the flight form on `/` and `/flights`. Stability: 5 repeats × 4 projects = **280 / 280 passed, zero retries**. One existing structural test (`tests/flight-request-notification.spec.ts`, "handleSubmit returns early on a ref guard, before validation…") searched the source for `validateClientSide()`; it now searches for `validateClientSide(isValidPhone)` and additionally asserts the wait branch sits behind the double-submit guard — intent unchanged.

Full website suite on the new build (`npx playwright test` over Desktop Chrome + Mobile 320/375/390, 2 workers, production build, no CRM configured): **1,283 passed, 8 skipped, 4 failed, 1 flaky** — the 4 failures were the structural test above, once per project (fixed, then 364 / 364 passed across the four projects for that file); the 1 flaky was one of my new tests (a fill that raced the plain→rich input swap, which re-parses a partial number — existing behaviour, not caused by this change), fixed by waiting for the upgraded field where load order is not the subject (a second, harness-only flake — a response body read after the page had closed — was fixed in the test code as well) and by delaying the rich chunk longer than the validator chunk where it is. The full 4-project suite was not re-run as a single pass after those two test-only fixes; the affected files were re-run as stated. `tsc` and `eslint` on the website: clean; `next build`: PASS.

## 7. Before / after measurements

Method (identical for both builds): the production build served by `next start` on `localhost:3101`, no CRM configured; headless Chromium driven by Playwright; a fresh browser context per run (cold cache); medians of 3 runs (desktop) and 5 runs (mobile profile); the page is left to settle until no new request appears for 1.5 s. Network and CPU shaping through the Chrome DevTools Protocol. Metrics: encoded (gzip) and decoded (raw) bytes per script from `Network.loadingFinished`/`dataReceived`; FCP/LCP/CLS/long tasks/Event Timing from `PerformanceObserver`; TBT = Σ(long task − 50 ms) after FCP until settled; "phone field ready" = first appearance of `.PhoneInput`; typing = the upgraded field is tapped/clicked and `+14155709267` typed at 40 ms/key (max Event Timing duration); validation latency = submit click → phone error text present (invalid `+1415`); the contact page also does one complete valid submission against the unconfigured server (friendly-error path). **TTI is not directly measurable here; TBT and "phone field ready" are reported instead.**

Profiles: **desktop** = Chromium at 1280×800, no throttling. **mobile-emulated** = 390×844 @3×, touch, mobile user agent, 4× CPU slowdown, 1.6 Mbps down / 750 Kbps up / 150 ms RTT. **Both are browser emulation on this PC. No real iOS or Android device was available or used; none of these numbers is a real-device result.**

Baseline for `/contact` was re-measured after a restart because the first baseline pass exhausted the site's in-memory contact rate limit (8 per window), which changed the submit reply text on mobile; the table uses the clean baseline.

| Route · profile | Metric | Before | After |
| --- | --- | --- | --- |
| all three routes | phone metadata chunk in the HTML's script tags | yes (118.6 KB raw) | **no** |
| `/` desktop | JS before load event: gzip / raw KB | 238.6 / 752.3 | **208.4 / 634.2** |
| `/contact` desktop | same | 224.9 / 709.9 | **194.7 / 591.8** |
| `/flights` desktop | same | 238.6 / 752.3 | **208.4 / 634.2** |
| `/contact` mobile-emulated | same | 224.9 / 709.9 | **194.7 / 591.8** |
| `/flights` mobile-emulated | same | 238.6 / 752.3 | **208.4 / 634.2** |
| `/` mobile-emulated | same | 346.6 / 1169.8 | 346.8 / 1170.4 — **no change**: on this slow profile the load event fires at ≈5.3 s, after the post-hydration chunks, so this counter includes them |
| every route, both profiles | JS total once settled (gzip KB) | `/` 602.0 · `/contact` 337.2 · `/flights` 602.0 (desktop); 597.1 · 337.2 · 597.1 (mobile) | 602.4 · 337.6 · 602.4; 597.3 · 337.6 · 597.3 — **unchanged (+0.2…0.4)** |
| mobile-emulated | TBT ms: `/` · `/contact` · `/flights` | 298 · 280 · 279 | **223 · 162 · 209** (−25 % · −42 % · −25 %) |
| desktop | TBT ms | 0 · 0 · 0 | 0 · 0 · 0 |
| desktop | FCP ms: `/` · `/contact` · `/flights` | 212 · 176 · 168 | 196 · 164 · 168 |
| desktop | load event ms | 210 · 219 · 204 | 178 · 210 · 185 |
| mobile-emulated | FCP ms | 1540 · 1092 · 1352 | 1536 · 1120 · 1288 |
| mobile-emulated | LCP ms | 1796 · 1092 · 1352 | 1800 · 1120 · 1288 |
| mobile-emulated | load event ms | 5325 · 2311 · 2174 | 5349 · 2132 · 2091 |
| all | CLS | 0 | 0 |
| desktop | rich phone field ready ms | 648 · 636 · 625 | 651 · 607 · 595 |
| mobile-emulated | rich phone field ready ms | 5428 · 3920 · 3949 | 5426 · 3807 · 3921 |
| mobile-emulated | max input-event duration while typing, ms | 96 · 72 · 80 | 80 · 72 · 80 |
| desktop | submit → phone error ms | 12.7 · 8.3 · 16.9 | 14.0 · 10.6 · 13.4 |
| mobile-emulated | submit → phone error ms | 75.5 · 45.2 · 57.1 | 59.9 · 41.9 · 51.5 |
| `/contact` | complete valid submit → server reply ms (desktop / mobile-emulated) | 78 / 359 | 87 / 364 |

Reading it: the transfer/parse reduction on the critical path and the main-thread blocking reduction on the slow profile are real and repeatable in this setup; paint and load-event timings moved by amounts that are within the run-to-run spread of 3–5 runs (differences under ≈5 % should be treated as noise); typing, validation latency and submit behaviour are unchanged; layout shift is zero before and after; total bytes are unchanged for the reason given in section 6. All typed values were reproduced exactly, an invalid number produced the same message before and after, and a valid number produced no phone error before and after (all runs).

Touch and keyboard: exercised in the emulated phone profile with `tap()` on the field and the submit button, and by Enter inside the field (the new spec, all four viewport widths 320/375/390 and desktop). Screen-reader behaviour was checked only through attribute assertions (`aria-invalid`, `aria-describedby`) and the existing axe suite (all pass); no assistive technology was used.

## 8. Real devices versus emulation

| Claim | Basis |
| --- | --- |
| Desktop numbers | Chromium on this PC, automated, no throttling |
| "Mobile" numbers and viewport tests | **Chromium emulation** (viewport, touch, user agent, CPU and network throttling). **No real iOS or Android device was used; iOS Safari and real Android Chrome were not tested.** |
| Real-device conclusions | none made |

## 9. Exact files changed in this task

CRM (`compass-tools-updated`, all unstaged): new `src/test/disposable-database.ts`, `src/test/integration-database-guard.ts`, `src/test/__tests__/disposable-database.test.ts`; modified `vitest.config.ts`; this document. (Files from the earlier part of the session, listed above, are unchanged by this task.)

Website (`Travel Agency Website-updated`, all unstaged): new `src/lib/phone-validator.ts`, `tests/phone-validation-loading.spec.ts`; modified `src/components/forms/PhoneNumberField.tsx`, `src/components/contact/ContactForm.tsx`, `src/components/flight-form/FlightRequestForm.tsx` (the last two already carried earlier uncommitted work, preserved), `tests/flight-request-notification.spec.ts`.

Not touched: both originals, any staged file, `package.json`/lockfiles, `next.config.ts`, `health-check.ts`, the Lead IP Reveal permissions, any dependency, any deployment or environment.

## 10. Git status before and after

| | Before | After |
| --- | --- | --- |
| CRM branch / HEAD / MERGE_HEAD | `work/commission-salesboard-notes-ui` / `5a77976` / `c6b8d8e` | identical |
| CRM index SHA-256 | `3422053116FF4701…9649BEC` | identical; `git ls-files -s` identical to the original baseline |
| CRM staged entries | 79 | 79 |
| CRM status entries | 167 | 171 (+3 new test/guard files, `vitest.config.ts`) |
| Website-updated branch / HEAD / index | `work/website-crm-api-integration` / `d1d1b61` / `EC6F1B99…F21D` | identical |
| Website status entries / staged | 15 / 0 | 19 / 0 |
| `compass-tools` and `Travel Agency Website` | 1,378 and 1,122 files byte-identical to the saved baseline | re-hashed: 0 missing, 0 mismatched |

No commit, push, stage, unstage, reset, stash, checkout, branch switch, merge or rebase was run. The merge state was not changed. No file in the staged set was edited. Workspace folders: still exactly the four.

## 11. Remaining failures, limitations and decisions

1. **Provide a disposable PostgreSQL** (blocks everything in sections 3–5). Choose: (a) you install PostgreSQL locally, loopback only, TLS on, empty `compass_test` and the `postgres` maintenance database on one port; or (b) approve my installing a portable server via the `embedded-postgres` npm package in the session scratch directory outside the workspace (earlier sessions did this; it downloads PostgreSQL binaries from the npm registry). Either way I will then run the guard against it first, then the 569 database tests, the advisory-lock test, the two migrations, the six contract tests and the browser flows, and record passed / failed / skipped separately.
2. **Phone metadata bytes**: unchanged in total (section 6). To remove them for visitors who never use the form, the rich input would have to be loaded on first interaction; that needs an approach that does not swap the input under the user's finger (for example a plain input until the user taps, then upgrade without moving focus) and a design check on phones. Not done; say if you want it.
3. The full 4-project website suite was not re-run as one pass after the final two test-only fixes (affected files were re-run, as stated above).
4. Real-device (iOS/Android) testing was not possible; section 8.
5. Still awaiting your decisions from the previous report and not done: dependency upgrades, contact-form signed visitor context, `health-check.ts`, `X-Powered-By`, Lead IP Reveal policy.

---

## Status entry — 2026-11-14: PostgreSQL integration testing deferred by user decision

* **PostgreSQL integration testing: DEFERRED by user decision.** Nothing further will be set up for now.
* **Disposable `compass_test` database: it did not exist, so no deletion was necessary.** Verified at the time of this entry: no PostgreSQL Windows service, no `psql`/`pg_ctl`/`initdb`/`postgres` on PATH, no PostgreSQL install folder, no `postgres`/`pg_ctl` process, nothing listening on ports 5432–5440, 54329 or 54330, no PostgreSQL data directory in the workspace or in this session's scratch directory, and no `INTEGRATION_*DATABASE_URL` or `PG*` environment variable. With no server there was no database to identify, and no database of any name was touched.
* **Database-dependent work: DEFERRED / BLOCKED — none of it passed and none was attempted:** database-backed CRM integration tests (25 files + `reference-data.test.ts`, 569 tests skipped), Prisma migrations against `compass_test` (the two new migrations remain unapplied), the sequence advisory-lock concurrency test, the six website-to-CRM contract tests, and database-backed browser flows.
* **No PostgreSQL was installed and no hosted database (Neon, Aiven or any other) was configured.**
* **No change to the CRM architecture, the Prisma schema, the disposable-database guard, `DATABASE_URL`, or any production configuration.** The guard from the previous addendum stays as it is: it remains inactive unless `INTEGRATION_DATABASE_URL` is set.
* No Git operation was run; the merge state and every staged and unstaged change are as they were; neither original project was touched.
