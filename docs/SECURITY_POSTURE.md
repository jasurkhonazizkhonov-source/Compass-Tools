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

AES-256-GCM, `cv2.<keyId>.<iv‖tag‖ciphertext>` with per-row AAD, legacy unversioned blobs decrypt with key id `v1`, explicit reveal grant + recent sign-in + rate limit + audit, `encryptedPan` omitted from ordinary Prisma queries, a database constraint refusing plaintext, ciphertext purge, no CVV storage. Environment expectations, **verified in `card-keyring.ts`**: `CARD_ENCRYPTION_KEY` is key id `v1` and is the only key that decrypts pre-envelope cards; `CARD_ENCRYPTION_KEYS` (`id:base64,…`) is only needed once a rotation begins (repeating `v1` in it is harmless); `CARD_ENCRYPTION_KEY_ID` is required **only** when the ring is set (otherwise the current key is `v1`); production-class environments additionally need exactly `CARD_VAULT_MODE=application-encryption-risk-accepted`; `APP_ENV` cannot open the vault. Nothing in the code generates, replaces or deletes a key.

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
