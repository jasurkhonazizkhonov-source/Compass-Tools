# Source and test review of the remaining security items - 2026-11-24

**This is a source and test review, not a penetration test.** It reads the code and runs the project's tests; it did not attack a running production
system, scan the network, or look at the production VPS, Cloudflare or Google Cloud settings (none of those were reachable from where this was done).
"Verified" below means "confirmed in the code and by an automated test on this branch", never "confirmed in production".

Scope: branch `release/compass-tools-2026-11-22`, working tree of 2026-11-24 (adds Google sign-in nonce binding, Admin Database Backup, the Lead-page
layout guard).

## 1. Items reviewed

| Item | Finding | Evidence | Needs an owner / infrastructure decision? |
|---|---|---|---|
| Cloudflare trusted client IP | The client IP is read **only** from headers the configured proxy sets itself (`cloudflare` -> `CF-Connecting-IP` only; Vercel is auto-detected from Vercel-set headers only). With `TRUSTED_PROXY` unset off Vercel nothing is read, and System Health says so. The compose file sets `cloudflare` and publishes no port, so the header cannot be sent by a client that bypasses Cloudflare. | `src/lib/request-ip.ts`, `src/__tests__/selfhost-deployment-config.test.ts` (no published port, `TRUSTED_PROXY=cloudflare`) | Yes, infrastructure: the host firewall must not expose port 3000, and `cloudflared` must be the only way in. Not checkable from here. |
| IPv4/IPv6 reserved ranges | Private, loopback, link-local, CGNAT and other reserved addresses, and IPv4-mapped IPv6 forms, are never stored as a visitor's IP and never looked up (`non-public-ip`). | `isPrivateOrReservedIp` in `src/lib/request-ip.ts` and its tests; `src/server/geo/ip-geolocation.ts` | No |
| GeoIP update safety | The update job downloads to a temp file, validates it as an MMDB with a known record before replacing anything, keeps the previous database on any failure, and runs on the `egress` network only. The app reads the volume read-only. No external geolocation API is called and no visitor IP leaves the server. | `docs/GEOIP.md`, `scripts/geoip-database.ts`, `deploy/ci-smoke.sh` (volume permissions, egress-only) | **Production install not performed** (no VPS access). See `docs/GEOIP.md` section 8. |
| Website request signing | Signing is enforced when `LEAD_INGEST_SECRET` is set; `WEBSITE_SIGNATURE_REQUIRED` only tightens it and now reaches the container (compose passes it). Unsigned traffic is accepted only while no secret is configured, and System Health shows that state. | `src/server/website-request-signature.ts`, `src/server/website-signature-guard.ts`, smoke step "Settings reach the container" | Yes: the website and the CRM must be given the same `LEAD_INGEST_SECRET` in one deliberate rollout. |
| Public website API | Bearer key compared in constant time, `Idempotency-Key` required, requests that came through the public Cloudflare edge are refused (404), reachable only on the internal `website_api` network. | `src/server/security/website-api-auth.ts`, smoke step "Website API" | Yes: the website must join `website_api`. |
| Server Action authorization | Every exported Server Action is either role-checked or on a reviewed public allow-list; a test fails when a new one is added without being classified. This pass added `getGoogleLoginNonce` (public by design: it only sets a random value) and the three Database Backup actions (Admin-only). | `src/__tests__/server-action-surface.test.ts` | No |
| Campaign / subscriber permissions, bulk actions | Bulk delete is Admin-only; Add-to-sequence follows the sequence permissions; both re-check on the server. | `docs/CAMPAIGN_SUBSCRIBER_ENROLLMENT_REVIEW_2026-11-23.md`, `src/__tests__/campaign-subscriber-enrollment-surface.test.ts` | No |
| Enrollment / Unenroll authorization | Unenroll checks the role and that the lead is visible to the caller on the server; the Lead page shows enrollment only inside the Sequences tab. | same review; layout guard added this pass | No |
| Cron authentication | `CRON_SECRET` bearer, constant-time compare, POST only, 401 otherwise; the scheduler never logs the secret. | `src/server/security/cron-auth.ts`, smoke step "Cron endpoint" | No |
| Admin-only full IP | Only Admins can reveal a full IP; everyone else sees a mask. Last sign-in IP/location is Admin-only through a global `omit`. | `docs/CRM_CONTACT_INQUIRY_IP_GEOLOCATION_VERIFICATION.md` (not touched), `src/server/actions/accounts.ts` tests | The earlier note about masked-vs-full IP disagreement between CRM and website remains a business decision. |
| Google sign-in | Nonce bound to an HttpOnly cookie (new this pass), verified email required, no auto-link/auto-create, no Admin from Google. | `src/server/auth/google-login-binding.ts`, `verify-google-token.ts` and their tests | Yes: the Google Cloud client must list the exact origin (`docs/DEPLOYMENT.md` 2a.1). |
| Database Backup | Admin only on page, actions and download; step-up login to create; strict id; no shell; no secrets in logs/audit; streamed; staged file removed after a full download or in 60 min; CVV data excluded. | `src/server/backup/**`, `src/app/api/admin/database-backup/**` and tests; see 2 below | Yes: see "Owner decisions" |
| Dependencies | `npm audit` (all and `--omit=dev`): 0 vulnerabilities on 2026-11-24. CI keeps the audit as a report-only job. | `npm audit` output | No |
| Secrets | A pattern scan of the tree (cloud keys, private keys, tokens, URLs with embedded passwords) found only documented placeholders, unit-test fixtures and throw-away CI values. No `.env` or key file is tracked (`.env.example` only). No dedicated scanner such as gitleaks was available. | scan of 2026-11-24 | Run gitleaks in CI if you want history scanned too (history was not scanned) |
| Health reporting | `/api/health` is bearer-protected for detail; System Health shows signer-IP capture, signing state, GeoIP database, website API, vault state; no secret values. | `src/app/api/health/**` tests | No |

## 2. Database Backup: threat check

| Threat | Mitigation | Test |
|---|---|---|
| Privilege escalation / non-Admin use | Admin check on the page (`notFound`), middleware route guard, every Server Action, and the download route (401 anonymous, 403 everyone else, identical response whether or not the id exists) | actions, route, proxy, sidebar tests |
| Unauthorised download | Same check first; a stale sign-in is refused; one-time file removed after a complete download | route tests |
| Path traversal | Ids must match `^compass-\d{8}T\d{6}Z-[a-f0-9]{8}$`; resolved path re-checked with `realpath`; symlinks refused | module + route tests |
| Command injection | `pg_dump`/`pg_restore` started with an argument array and no shell; no user text reaches an argument | module tests |
| Secret exposure | Password and TLS material only in the child's environment; all output redacted; audit rows hold size, hash and versions only | module + action tests |
| Unprotected restore | There is no in-app restore | panel text, docs |
| Resource exhaustion | One backup at a time, 30 min limit, disk check, streaming, 60 min staging | module tests |
| Incomplete backup offered | Written to `.partial`, read back with `pg_restore --list`, renamed only after it passes | module + integration tests |
| Retained CVV data | `--exclude-table-data=PaymentMethodCvv`, and the check fails if its data appears | module + integration tests |

Residual risks: a downloaded dump contains all customer data and *encrypted* card numbers - anyone who also holds the `.env` keys can read them, so
the file must be stored encrypted and off the server. A compromised Admin account can download a backup (it is audited and needs a fresh sign-in).

## 3. Owner / infrastructure decisions (nothing here was done)

1. Install the DB-IP database on the production VPS (`docs/GEOIP.md` section 8) - needs someone with SSH access.
2. Deploy this branch (the production site is still on an older build: the large enrollment notice on the Lead page is only gone in this branch).
3. Confirm the Google Cloud client lists the production origin; sign in once with a real and once with an unregistered account.
4. Rebuild the image on the VPS once so it carries `postgresql-client-17`; the first CI run of `deploy/ci-smoke.sh` is the first real test of the Dockerfile change
   (the PostgreSQL apt key fingerprint in the Dockerfile fails the build if wrong).
5. Rehearse the recovery in `docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` 12.6 on a spare VPS.
6. Decide where backups are kept off the server (and encrypted) - the app only stages them for an hour.
7. Roll out website request signing (`LEAD_INGEST_SECRET`) on both sides together.
8. Run a real penetration test if the CRM holds data that warrants one; this review is not one.

---

# Follow-up pass (same day, after the sequence work): findings, fixes and what remains

Still **a source and test review, not a penetration test**. "Fixed" means fixed in the code with a regression test; "verified" means a test or a local run proved it, never that production was checked.

## Findings that were real, and what was done

| # | Finding | Realistic abuse | Fix | Regression test |
|---|---|---|---|---|
| 1 | **No limit on failed Google sign-ins.** Each attempt calls Google to verify the token and writes a failed-sign-in row. | A script replaying tokens or probing accounts amplifies work (a Google call + a database write per request) and floods the Failed sign-ins log. | `SIGN_IN_FAILURES`: 15 failures per 15 minutes per client IP. **Only failures count** (a read-only peek first, a write only on a refusal), so a shared office signing in successfully is never blocked; without a trusted client IP nothing is limited; a counter that cannot be read never turns sign-in into an error. | `sign-in-rate-limit.test.ts`, `rate-limit-failures-only.integration.test.ts` (real PostgreSQL) |
| 2 | **Gmail connect start and callback unbounded** (each is a round trip to Google's token service). | A signed-in user (or a stolen session) loops it. | `GMAIL_CONNECT`: 12 per 15 minutes **per account**. | `rate-limit-actions.test.ts` |
| 3 | **Database backup create / download / delete unbounded.** | A stolen Admin session repeats a whole-database dump or download. | Per-Admin limits; download answers **429 with `Retry-After`**; only an authorised Admin ever reaches the counter. | same |
| 4 | **Bulk actions, enrollment and enrollment recovery unbounded.** Retry/resolve can send a real email. | A script enrolls or retries without end. | Per-account limits (`SEQUENCE_ENROLL` 300, `ENROLL_ALL_CONTACTS_BATCH` 1,500 batches = 150,000 contacts, `BULK_ACTION` 60, `SEQUENCE_RECOVERY` 60 per 15 min). | same |
| 5 | **Sign-in page had `'unsafe-inline'` for scripts.** It was on the base policy (pre-rendered public pages). | An injected inline script on the one public page that handles a credential flow would run. | `/login` is rendered per request, so it now gets the strict per-request-nonce policy (no `'unsafe-inline'`, no `'unsafe-eval'`), plus Google's stylesheet on `style-src` of that page only. | `csp-nonce.test.ts`; browser run below |
| 6 | **Permissions-Policy covered only four features; no window isolation.** | A compromised frame could request USB, serial, Bluetooth, motion sensors, screen capture. | Everything the CRM does not use is switched off; `Cross-Origin-Opener-Policy: same-origin-allow-popups` (plain `same-origin` would break Google's sign-in popup). | `security-headers.test.ts` |
| 7 | **Sequences ignored the do-not-email list.** An address of a marketing subscriber who unsubscribed or was suppressed (bounce/complaint) could still be enrolled. | Emailing someone who opted out / bounced. | Enforced at enrollment **and again at send time** (an address that becomes blocked later is dropped; none left = the enrollment fails visibly). | `enroll-all-contacts.integration.test.ts` |
| 8 | **Customer-supplied values in rich emails.** A customer's name goes into HTML email. | Markup injection into the email that other people open. | Values are HTML-escaped before the cleaner runs; the HTML is cleaned on the server at save **and** at send with the campaign allow-list; the preview runs in a sandboxed frame with no permissions. | `sequence-content.test.ts`, `sequence-steps.integration.test.ts` |
| 9 | **Restore script aborted on a brand-new database** (its safety backup refused an empty dump) - a recovery defect, not an attack. | Disaster recovery failing at the moment it is needed. | `restore-db.sh --replace` skips the safety backup, and says so, only when the database has no CRM tables. | CI rehearsal (not run locally) |

## Reviewed with no change needed (evidence in the code)

* **SQL injection:** no `$queryRawUnsafe` / `$executeRawUnsafe` outside tests; raw SQL uses tagged templates (parameters).
* **XSS:** the only `dangerouslySetInnerHTML` is JSON-LD built by `serializeJsonLd`; no `eval` / `new Function`; the signed-in CRM and card pages already ran the nonce policy.
* **SSRF:** no server-side fetch takes a URL from a user. Links and image addresses typed into an email are embedded, never fetched by the server. The GeoIP download is an operator command.
* **Command injection:** `child_process` is used by the backup (argument array, no shell) and the build scripts only.
* **CSRF:** state-changing operations are Server Actions (Next verifies the Origin) or authenticated route handlers with SameSite cookies; the Gmail and Google flows have their own state / nonce.
* **IDOR / cross-company:** every enrollment, step, lead and contact action is scoped by the visibility predicates and re-checked on the server; the new actions are covered by the Server Action surface guard.
* **Webhook signature / replay, cron authentication, Admin-only IP, uploads, secrets, dependencies:** unchanged from the review above (`npm audit`: 0 vulnerabilities on 2026-11-24, re-run after the editor packages were added).
* **Database TLS / containers:** unchanged; the app image now also carries the PostgreSQL 17 client (key fingerprint verified, see docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md 12.5).

## New data access: what the reply feature reads

Gmail `gmail.metadata`, optional, read-only: labels and eight headers (From, Auto-Submitted, Precedence, X-Autoreply, X-Autorespond, X-Auto-Response-Suppress, X-Failed-Recipients, Return-Path, Content-Type), only for conversations the CRM's own sequence emails started, never a body, subject or recipient list. Gmail classifies the scope as restricted (see docs/DEPLOYMENT.md 2c for what Google requires).

## Unresolved, and who has to decide

1. **Scripts: `'unsafe-inline'` remains only where the build cannot hash** (API routes, error pages, Cloudflare/Vercel builds). The 13 pre-rendered marketing pages moved to a hash-based policy on 2026-11-25 (`docs/CSP.md`); the Docker image's header is not yet verified on a running container.
2. **Styles: reduced, not gone.** Style *elements* no longer allow `'unsafe-inline'` except on `/login` (Google's script adds an inline `<style>`); style *attributes* keep it (they cannot carry a nonce). Details, evidence and the full exception list: `docs/CSP.md`.
3. ~~No rate limit on CRM emails sent one at a time~~ **Done in the continuation pass:** `STAFF_EMAIL_SEND` (100 per 15 minutes per account) on quote, airline-confirmation, cancellation-confirmation and inquiry-reply emails. Bulk sending (sequences, campaigns) is unaffected: it has its own quota.
4. **`upgrade-insecure-requests` is not set**: it would break `http://localhost` production-mode runs; HTTPS is enforced by Cloudflare and HSTS.
5. **Cloudflare / firewall / Google Cloud configuration cannot be checked from the repository** (host port 3000 closed, `cloudflared` the only way in, the OAuth client's origins and the new scope, DNS).
6. **A penetration test has not been done.**
