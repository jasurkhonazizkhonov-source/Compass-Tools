# Security posture — what is verified, what is not

Status labels: **SOURCE** = read in the code · **TEST** = proven by an automated test · **REAL PG** = proven against a real PostgreSQL · **LIVE** = observed on the deployed site · **INFRA** = only the database/hosting administrator can verify or change.

## 1. Who can see and reveal what (IP addresses)

| Role | Masked lead IP (`203.x.x.x`) | Full lead IP (Reveal) | Masked / full booking signer IP | Notes |
|---|---|---|---|---|
| Admin | any lead in the company | **yes** (role-based, no grant needed) | masked; **Reveal yes** | step-up + rate limit + audit |
| Manager | own + team's leads | **only with the `bookings.reveal_ip` grant**, and only for leads in scope | masked; Reveal only with the grant | |
| Travel Agent | own leads, masked only | **never** (role not eligible; a forged grant is refused) | masked only | the internal "Booking Form Signed" email also shows the signer IP **masked** |
| Ticketing Agent | no Leads area | no (has no access to leads) | masked; Reveal only with the grant | eligible role for booking IP |
| Flight Expert | no Leads area | no | masked only | |
| Marketing Agent | no | no | no | |

SOURCE: `permissions.ts` (`canViewLeadSubmissionInfo`, `REVEAL_IP_ELIGIBLE_ROLES`, `canRevealBookingIp`), `queries/lead-submission-info.ts`, `actions/lead-submission.ts`, `actions/booking-security.ts`. REAL PG: `lead-ip-authorization.integration.test.ts` (22 tests: Admin, owning Manager, owning Agent, other-team Manager, other-team Agent, Marketing, Ticketing, unauthenticated, inactive; stale sign-in; missing sign-in; rate limit; audit without the IP; lead-id tampering; forged grant).

The full lead IP is read in exactly two places: the explicit Reveal action and nothing else; it is never in a list payload, the page HTML, a log line, an email the CRM sends, or a search. (The website's own internal notification email keeps the full IP — that is the website's, by decision.) Whether Admin/Manager/Ticketing *should* see full addresses at all is a business/legal decision: the implementation is deliberately conservative (masked by default, audited, time-limited) and unchanged.

## 2. Step-up authentication ("recent sign-in", not MFA)

`requireRecentLogin(session.createdAt)` — the account must have completed a fresh Google sign-in within 15 minutes (the session timestamp is never refreshed by activity). In every production-class environment it is enforced; local development passes through explicitly. **This is not app-managed MFA and does not claim to be**: whether the user completed 2-Step Verification is decided by their Google account, which the CRM cannot observe.

| Action | Guards |
|---|---|
| Reveal a full card number | explicit `payments.reveal` grant on an eligible role, row-level visibility, rate limit, **recent sign-in**, audit |
| Reveal booking signer IP / lead IP / IP vault history | eligible role + `bookings.reveal_ip` (Admin by role), row-level visibility, rate limit, **recent sign-in**, audit (denied + rate-limited attempts too) |
| **Change a role, change a login email, grant a payment or booking permission, create an Admin** *(new in this pass)* | Admin only + **recent sign-in** (returned message, never a masked error); refusal audited as `ACCOUNT_PRIVILEGE_CHANGE_DENIED` without values; revocations and ordinary profile edits are not blocked. REAL PG: `account-privilege-stepup.integration.test.ts` |
| Create / edit / remove a stored payment method | payment permissions on an eligible role, row-level visibility, rate limit, audit (denied + rate-limited). No recent-sign-in requirement: these actions do not reveal card data. |
| Deactivate an account, hide/show it, change a Manager's team | Admin only, audited. Deliberately no step-up: they reduce or reshape reach rather than grant new privileges. |

**MFA assessment — REQUIRES FUTURE SECURITY PROJECT.** The repository has no MFA foundation (no TOTP/WebAuthn enrollment, recovery codes, or step-up claim in the session) and the identity provider is Google. A genuine MFA requirement means either (a) enforcing 2-Step Verification for every user at the **Google Workspace** level (an infrastructure/admin policy — works only if every user signs in with an organisation-managed account) or (b) building enrollment, verification, recovery and a step-up claim into the session. Neither is something to bolt on partially; no fake MFA flag exists or should be added (`requireMfa()` still fails closed in production).

## 3. Audit log

- **What is recorded** (who, target, when, result, reason code): payment-method create/edit/remove/reveal/purge and denied/rate-limited attempts; card key rotation; booking and lead IP reveals (success, denied, rate-limited); account creation, role, status, visibility, booking-permission and payment-permission changes; privileged-change step-up refusals; lead / contact / quote / booking deletions and denials; lead and contact reassignment; Manager team changes; **airline-confirmation emails (sent, failed, denied) and New Sale / Cancellation team notifications (sent, failed, denied)** — with ids, counts and reason codes only.
- **Never recorded:** card numbers, CVV, passwords, OAuth tokens, email addresses of customers, message bodies, the IP being revealed. TEST: assertions in `lead-ip-authorization`, `send-airline-confirmation-email`, `send-new-sale-notification`.
- **Unsubscribes** are recorded on the subscription itself (time, reason, source), not in `AuditLog`.
- **Tamper resistance (new):** migration `20261005000200_audit_log_append_only` extends the database trigger that already protected card-vault rows to **every** `AuditLog` row: no UPDATE or DELETE succeeds — through Prisma or raw SQL — except clearing `actorId` when the actor's account is removed. REAL PG: `audit-log-integrity.integration.test.ts`. The application never issues an UPDATE/DELETE on `AuditLog` (SOURCE).
- **Limits — INFRA:** this resists application-level tampering and mistakes. It does not stop someone who can alter the database schema (drop the trigger) or a database-provider administrator, and `TRUNCATE` is not covered. True immutability needs write-once (WORM) storage or an external log sink; that is not implemented and is not claimed.

## 4. Payment vault (unchanged — preserved)

AES-256-GCM, `cv2.<keyId>.<iv‖tag‖ciphertext>` with per-row AAD, legacy unversioned blobs decrypt with key id `v1`, explicit reveal grant + recent sign-in + rate limit + audit, `encryptedPan` omitted from ordinary Prisma queries, a database constraint refusing plaintext, ciphertext purge, and a **temporary (≤ 24 h), encrypted, Admin-only** security-code record (`PaymentMethodCvv`; `docs/CARD_VAULT_SECURITY.md` §19 — REQUIRES PCI/QSA/ACQUIRER REVIEW). Environment expectations, **verified in `card-keyring.ts`**: `CARD_ENCRYPTION_KEY` is key id `v1` and is the only key that decrypts pre-envelope cards; `CARD_ENCRYPTION_KEYS` (`id:base64,…`) is only needed once a rotation begins (repeating `v1` in it is harmless); `CARD_ENCRYPTION_KEY_ID` is required **only** when the ring is set (otherwise the current key is `v1`); production-class environments additionally need exactly `CARD_VAULT_MODE=application-encryption-risk-accepted`; `APP_ENV` cannot open the vault. Nothing in the code generates, replaces or deletes a key.

Rotation tooling (`npm run cards:rotate`): dry run by default; `--apply` is refused without `--confirm`; canary batches with `--ids=`; per-row decrypt → re-encrypt → re-decrypt-and-compare → compare-and-swap write; failures listed by id + code and left untouched; idempotent and resumable; one audit row with counts. **New:** `--verify` — a read-only proof (every card decrypts under its own key; per-key row counts; `retirableKeyIds`) to run before an old key is retired. TEST: `card-key-rotation.test.ts` (16), `card-vault.integration.test.ts`. **No production rotation was performed or attempted.**

## 5. Observability

Exists: `GET /api/health` (database reachability and latency, connection-pool state, vault readiness, TLS verification, schema/migration currency), the Admin **System Health** page backed by de-duplicated `recordHealthEvent` incidents (e.g. email send failures by category code), and categorised, secret-free server log lines (`safe-error-log`). **Not present:** an external error-monitoring / APM provider, alert routing, or log retention beyond Vercel's own runtime logs — **gap, INFRA/business decision** (adding a provider needs a data-handling review: it must never receive card, IP or customer data). Vercel runtime/deployment logs are not readable from this repository (no CLI/token); they were therefore not inspected: UNVERIFIED.

## 6. Database infrastructure checklist — INFRA

| Item | Status | How to verify |
|---|---|---|
| Connection encryption (TLS) | **LIVE** — `/api/health` reports `databaseTls: "verified"` (certificate verified against the configured CA) | already done |
| Storage encryption at rest | **UNVERIFIED — INFRASTRUCTURE** | provider console: the database service's "encryption at rest" / disk encryption setting and the key owner |
| Automated backups enabled | **UNVERIFIED — INFRASTRUCTURE** | provider console: backup schedule, last successful backup time |
| Backup encryption | **UNVERIFIED — INFRASTRUCTURE** | provider documentation / console: are backups encrypted, with whose key |
| Backup retention | **UNVERIFIED — INFRASTRUCTURE** | provider plan: retention window in days; compare with `CARD_RETENTION_DAYS` and the key-retention rule in `CARD_VAULT_SECURITY.md` (an old card key must outlive every backup that uses it) |
| Point-in-time recovery | **UNVERIFIED — INFRASTRUCTURE** | provider: PITR enabled and its window |
| Disaster-recovery test | **UNVERIFIED — INFRASTRUCTURE** | restore a backup into a scratch database and run `npm run test:fresh-db` + `npm run migration:safety-check`; record the date |
| Who can reach the database | **UNVERIFIED — INFRASTRUCTURE** | provider: IP allow-list / private networking; credential holders; rotation of `DATABASE_URL` |

TLS to the database says nothing about backups or disk encryption; none of the unverified rows is claimed.

## 7. Sessions — single active device, 24-hour lifetime, "Sign out all users"

Model (SOURCE: `lib/dev-session.ts`, `server/auth/establish-session.ts`, `proxy.ts`): the browser holds one opaque random token (httpOnly, SameSite=Lax cookie `compass_dev_account`); the server matches it against `Account.activeSessionId` (unique) on **every** request — in `proxy.ts` for pages and in `getCurrentAccount()` for server actions and API routes. A token that matches no account, or whose account is not ACTIVE, or whose session is older than 24 hours, is refused.

| Rule | How it is enforced | Proof |
|---|---|---|
| **One active device per account** | A new sign-in overwrites `activeSessionId` in a **single SQL statement** that first locks the account row (`FOR UPDATE`), so near-simultaneous sign-ins queue and exactly the last one to commit holds the only valid token. The replaced token is recorded by **SHA-256 only** in `RevokedSession`. | REAL PG: `session-lifecycle.integration.test.ts` — PC→phone→PC, and a race of 8 concurrent sign-ins × 5 rounds (exactly one valid token every round; removing the lock makes 4 of 5 rounds fail, i.e. the test is sensitive to it). |
| **Message for the old device** | `proxy.ts` looks the dead token's hash up in `RevokedSession` and redirects to `/login?reason=superseded`, which shows "Your session ended because this account signed in on another device." — a fixed sentence: never the new device's IP, place or browser. An unknown/garbled token gets the plain sign-in page. | TEST: `login-page.test.tsx`, `session-token.test.ts`; REAL PG: proxy redirects. |
| **24-hour ABSOLUTE lifetime** | `sessionCreatedAt` is set only when a session is established; nothing (heartbeat, page loads, API calls) ever moves it. `isSessionExpired` is true **at** 24h, not after. No sliding renewal. A new sign-in starts a new 24 hours. | TEST: `dev-session.test.ts` (1 ms before / exactly at / after); REAL PG: pages, proxy and heartbeat. |
| **Server/API routes** | They authenticate through `getCurrentAccount()`, which returns `null` for an expired, superseded **or deactivated** session — the same checks as the page gate (a source-level test asserts every CRM area is in the proxy matcher, that only the known modules read the session cookie, and that the one session-authenticated API route uses `getCurrentAccount`). Deactivating or removing a user also clears their session in the same transaction. | REAL PG + TEST: `session-enforcement-coverage.test.ts`. |
| **Sign out all users** | Admin-only (`signOutAllUsers`, company-scoped), requires a sign-in within 15 minutes (returned message, refusal audited as `SESSIONS_SIGN_OUT_ALL_DENIED`). One statement locks the company's active accounts, records each token's hash as `SIGNED_OUT_ALL`, and clears the sessions; the Admin is redirected to `/login?reason=signed-out-all` ("You were signed out by an administrator."). Audited as `SESSIONS_SIGNED_OUT_ALL` with a count only. **One-shot**: there is no persistent "everyone is signed out" flag, so a sign-in made afterwards is valid immediately. Distinct from 24-hour expiry and single-device replacement. | REAL PG: ends every session, other company untouched, hash-only records, audit without tokens, non-Admin and stale-Admin refused, everyone can sign in again. |

`RevokedSession` keeps a row only as long as the session it describes could still be valid (rows older than 25 hours are removed on the next sign-in). Raw tokens remain stored in `Account.activeSessionId` (they must be, to be matched); that column is **omitted from every Prisma read** unless a query opts in (global `omit` in `lib/prisma.ts`), so a generic query, the `/accounts` directory or an object passed to a client component cannot carry it. Storing only a hash of the token would be a stronger design but forces every signed-in user to sign in once and reworks every seed; **REQUIRES BUSINESS DECISION**, not done.

## 8. Last sign-in IP and approximate location (Admin → Users)

- **What is recorded** (only on a *successful* sign-in — `establishSession` is reached only after Google verified the identity **and** the CRM authorized the account): the time, the client IP and the approximate city / region / country / time zone. A failed or denied attempt never calls it and so never overwrites the last good record; activity never does either. The newest sign-in replaces the older record completely.
- **Where the values come from:** the existing trusted-proxy rule (`getClientIp` / `getRequestLocation`): forwarded-for and Vercel geo headers are believed only when the platform is trusted (auto-detected on Vercel, otherwise explicit `TRUSTED_PROXY`). On an untrusted path nothing is stored (never the proxy's own address). Location is **approximate and may be wrong or absent** (VPNs, mobile networks, corporate gateways); when it is unavailable the Users page says "Location unavailable" — nothing is guessed. The Admin-**assigned** `Location` column is a different field and is never changed by a sign-in.
- **Who can see it:** Administrators only, enforced **in the query** (`getAccountSignInDetails` returns nothing for any other role, a missing viewer, or an Admin of another company) and by the global Prisma `omit`. It is not in any list/search payload, public API, email or log line. REAL PG: `session-lifecycle.integration.test.ts` (Admin-only, cross-company, omit).
- **Retention:** one record per account (the latest). Whether Administrators should see full addresses at all is a business/legal decision, as for lead IPs.

## 9. Confirmations — no native browser dialogs

Every `window.confirm` / `alert` / `prompt` was replaced by the CRM's own modal (`components/crm/confirm-dialog.tsx`, `input-dialog.tsx`): `role="alertdialog"` with title and description, focus trapped and starting on Cancel, Escape and Cancel close it, focus returns to the control that opened it, a specific destructive label (never "OK"), a pending state that blocks dismissal and double-clicks, and the server's refusal shown inside the dialog. **Server-side authorization is unchanged**: the dialog is a UX step, never a security control. A static regression test (`no-native-dialogs.test.ts`) fails the build if a native dialog call re-enters `src`. Consequential actions that used to fire on one click now ask first: delete lead/contact/quote/booking, remove a payment card, remove a flight segment (does **not** save the itinerary), cancel a quote, approve/disregard/send/resend a cancellation, delete a note / phone / email / sequence step, remove the company logo, notify the team of a sale/cancellation, send the cancellation confirmation, change a role, grant a payment/booking permission, and sign out all users. Routine, reversible actions (saving a field, sending a quote the agent just composed) do not.

## 10. Items that are NOT closed by this code (status, no assumptions)

| Item | Status |
|---|---|
| Website lead capture adopting the signed visitor-context contract | **REQUIRES EXTERNAL WEBSITE DEPLOYMENT** — the CRM side is live and tested; the website must send the signed headers. |
| `LEAD_INGEST_SECRET` provisioning | The owner reports the shared value is now set in BOTH live environments. `/api/health` shows `readiness.leadIngestSecret` (`configured` / `not_configured`, a category only, read at runtime of the current deployment — an environment variable added in Vercel only reaches a deployment built/started after it was added, so a `not_configured` reading on an OLDER deployment is expected). If the two values differ, signed visitor context is refused and website leads are stored without a visitor IP (fail-safe, never a wrong IP). The value is never generated, logged or committed; this repository cannot see production's value, so equality of the two values is not verifiable from here. |
| Database backups, backup encryption, encryption at rest, retention, point-in-time recovery, disaster recovery, network allow-list | **UNVERIFIED — INFRASTRUCTURE** (see §6); nothing is claimed. |
| Real MFA | **REQUIRES FUTURE SECURITY PROJECT** (§2). |
| External monitoring / alerting | **REQUIRES INFRASTRUCTURE ACTION** (§5). |
| Hash-only storage of the session token; WORM audit storage | **REQUIRES BUSINESS DECISION** (§7, §3). |
| Re-pointing historical flight segments at corrected airlines | **REQUIRES BUSINESS DECISION**; the operator tool exists and changes nothing by default (`AIRLINE_REFERENCE_DATA.md`). |
| `BFT-` booking-reference prefix | Verified **internal-only** (never printed on any customer-facing email; `booking-reference.test.ts`); unchanged. |
