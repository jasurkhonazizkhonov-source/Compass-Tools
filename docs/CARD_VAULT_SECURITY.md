# Card vault security — model, key management, procedures

This is the security reference for the CRM's own card vault. It states what the
code does, what an operator must do, and what is **not** solved. Nothing here is
a compliance claim.

> **This application is not PCI DSS compliant and this design does not make it
> so.** Encrypting the card number in the application's own database keeps the
> application, its database, its backups and its staff **in PCI DSS scope**. The
> remaining gaps are listed in [§13](#13-remaining-risks-and-pci-dss-gaps).

## 1. What is stored, and what never is

| Data | Stored? | Where | Classification / protection |
|---|---|---|---|
| Card number (PAN) | Yes | `PaymentMethod.encryptedPan` | **Encrypted** (AES-256-GCM, versioned key ring, row-bound). Omitted from every ORM read by default. Decrypted only by the audited Reveal action. |
| Cardholder name | Yes | `PaymentMethod.cardholderName` | Cardholder data stored **with** a PAN; ordinary column, **access-controlled** (same visibility rules as the booking/contact). Not encrypted: it is shown in masked views and needed for search/display; encrypting it would force a decrypt on every page view and widen exposure of the key. |
| Expiry month / year | Yes | `expiryMonth`, `expiryYear` | Same as cardholder name (shown in masked views; needed for expiry checks). |
| Last four digits, brand | Yes | `last4`, `cardBrand` | Masked display data. Not sensitive by itself. |
| **CVV / CVC / security code** | **Never** | nowhere | Not collected, transmitted to the server, held in memory, cached, logged, encrypted or recoverable. No field in the form, no key in the action's input schema, no column anywhere. A client that still sends one has it dropped; a real-database test scans every table for a marker value. |
| PIN, magnetic-stripe/track data | Never | nowhere | Same. |
| PAN fingerprint / hash / search index | **No** | nowhere | There is **no product requirement to look a card up by its number**, so none is built (an HMAC index would only add another PAN-derived value to protect). If one is ever required it must be a keyed HMAC-SHA-256 (never a plain hash) under its own key, stored separately and never returned to a client. A guard test fails if a fingerprint column appears without this document being revisited. |

Field-level rationale: PCI DSS requires the PAN to be rendered unreadable
wherever it is stored; it permits cardholder name and expiry to be stored, with
protection. The sensitive authentication data (CVV, PIN, track data) may not be
retained after authorization at all — hence "never".

## 2. Card lifecycle and every place a PAN can exist

1. **Customer browser** — typed into `card-payment-section.tsx`; React state only.
   No browser storage or cookies (guard-tested), no analytics/telemetry library
   exists in the project. Cleared from state after a successful submit; kept
   after a rejected one so the customer can retry.
2. **Network** — HTTPS only (HSTS). Sent as a Next.js Server Action POST body to
   the same origin. It is **not** in a URL or query string (guard-tested).
3. **Server action** (`submitBooking`, `addContactPaymentMethod`,
   `editPaymentMethod`) — validated (Luhn, expiry), encrypted immediately, the
   plaintext reference is dropped from the parsed input as soon as it is
   encrypted. Errors returned to the customer are generic and never echo input.
   *Limit:* JavaScript strings cannot be zeroed; copies live until garbage
   collection. Key buffers **are** zeroed after each use.
4. **Encryption** — `card-encryption.ts` via `payment-vault.ts`.
5. **Database** — ciphertext only (a CHECK constraint rejects anything that
   looks like a plaintext number).
6. **Backups** — contain the ciphertext (see [§10](#10-backups-retention-and-deletion)).
7. **Reveal** — the single request-facing decryption path (see [§7](#7-admin-reveal)).
   The number is returned to that call's caller, shown for 30 seconds, hidden on
   tab change/blur, not selectable or copyable, never persisted.
8. **Audit log / logs / errors** — last four digits at most. Audit metadata is
   additionally scrubbed of any card-shaped digit run. Server error records
   (`System Health` incidents) redact card-shaped numbers.
9. **Deletion** — removing a card **destroys** the ciphertext (§10).
10. **Not present** — no exports, no imports, no background job, no email or
    notification, no public API touches a card number. Emails carry brand, last
    four and expiry only.

A repo-wide test suite (`src/__tests__/card-data-hygiene.test.ts`) enforces:
only official test card numbers anywhere in the repository; no hard-coded or
client-side keys; no client component importing the vault; `encryptedPan`
referenced only by the allow-listed files; decryption reachable from exactly one
request-facing action; no console call that mentions card variables; no card
number in URLs or browser storage.

## 3. Encryption design

- **Algorithm:** AES-256-GCM (Node `crypto`/OpenSSL). No custom cryptography.
- **IV:** a fresh 96-bit `randomBytes` value **per encryption** (tested: 200
  encryptions of the same PAN give 200 distinct IVs and ciphertexts).
- **Authentication:** 128-bit tag, **pinned** (`authTagLength: 16`) and verified
  before any plaintext is returned; a too-short blob is rejected up front.
- **Envelope:** `cv2.<keyId>.<base64url(iv ‖ tag ‖ ciphertext)>`.
  - The key id selects the ring key (rotation).
  - The **row id is authenticated data (AAD)**: a ciphertext copied into another
    row fails authentication instead of decrypting there.
- **Legacy:** blobs written before envelopes existed (`base64(iv ‖ tag ‖ ct)`, no
  AAD, key = `CARD_ENCRYPTION_KEY` = id `v1`) still decrypt and are upgraded by
  rotation.
- **Fail closed:** missing/invalid ring → `NOT_CONFIGURED`; unknown key id →
  `KEY_UNKNOWN`; malformed → `MALFORMED`; tampered / wrong key / wrong row →
  `AUTH_FAILED`; removed card → `PURGED`. Errors carry only that code — never a
  value, key or OpenSSL message. There is no plaintext fallback.
- **Not solved:** no HSM/KMS, no envelope encryption with a separate KEK, no dual
  control. The key lives in the same process and environment that reads the
  ciphertext.

## 4. Key management

### Configuration (secrets — set in the host's secret store, never in Git)

| Variable | Meaning |
|---|---|
| `CARD_ENCRYPTION_KEY` | The original single key. Still supported: key id **`v1`**, the only key that decrypts legacy (pre-envelope) cards. |
| `CARD_ENCRYPTION_KEYS` | Optional ring: `id:base64key,id:base64key`. Ids are 1–12 letters/digits. Each key is base64, exactly 32 bytes. |
| `CARD_ENCRYPTION_KEY_ID` | The id new cards are encrypted under. **Required when `CARD_ENCRYPTION_KEYS` is set** — never a silent default. Defaults to `v1` when only `CARD_ENCRYPTION_KEY` is used. |
| `CARD_VAULT_MODE` | Explicit enablement in production-class environments (see §5). |

**Format (verified against `card-keyring.ts`):** `CARD_ENCRYPTION_KEYS` is
plain comma-separated text `id:base64key,id:base64key` — not JSON. An id is 1–12
letters/digits (not secret; chosen by you; never generated). Each key is base64 of
exactly 32 bytes. The same id listed twice with the **same** key is accepted; with
a **different** key it is rejected. A bare key without `id:` is invalid.
`CARD_ENCRYPTION_KEY` is **not obsolete**: it is key id `v1`, the only key that
can decrypt cards stored before envelopes existed.

Generate a key: `openssl rand -base64 32`. **The application never generates a
key.** A key regenerated per deployment would make every stored card
undecryptable, so keys only ever come from the owner.

### Startup / continuous validation

`card-keyring.ts` validates the ring on every use: base64, 32 bytes, unique
well-formed ids, current id present. Problems are reported by **variable name
and key id only**. Health surfaces (§12) show the state and the current key
version label. Any problem closes the vault (fail closed).

### Exposure analysis (what protects the key, honestly)

| Threat | Today |
|---|---|
| Vercel secret exposure | Env vars are readable by anyone with project access and by the running functions. Restrict project access; mark the variables *Sensitive* in Vercel. |
| Developer / CI access | Anyone who can read production env vars can decrypt every card **if** they also read the database. Keep production env access to as few people as possible; never put production keys in CI logs, `.env` files committed to Git, screenshots or chat. |
| Database administrators | They see ciphertext only. They cannot decrypt without the ring. Keep the ring and DB credentials with different people where possible. |
| Backups | Contain ciphertext; useless without the ring — **but** restoring an old backup needs the key that encrypted it (§6). |
| Logs | The ring is never logged; health/readiness output exposes at most a key id label. |
| Accidental Git commits | `.env*` is git-ignored; a repo test rejects hard-coded keys. See §11 for the history audit. |
| Key loss | **Unrecoverable**: without the ring the cards cannot be read. Keep an offline, access-controlled copy of every key that protects live data or a restorable backup. |

## 5. Environment model and how the vault is enabled

- The environment is decided in `src/lib/env.ts`: `APP_ENV=production` →
  production; `VERCEL_ENV` (production **and preview**) → production-class;
  `NODE_ENV=production` → production; otherwise test/development.
  **`APP_ENV` can only tighten.** `APP_ENV=staging`, `development`, `true`, … do
  nothing on a production build or a Vercel deployment. A production deployment
  is always identifiable as production.
- In a production-class environment the vault opens **only if both**:
  1. the key ring is valid, **and**
  2. `CARD_VAULT_MODE` is set to exactly
     **`application-encryption-risk-accepted`** — a deliberately long,
     non-boolean phrase recording that the owner accepts application-level
     (non-PCI DSS-grade) key management. `true`, `1`, `enabled`, `staging`, or a
     wrong-case value do **not** open it.
  Local development and tests need only a valid ring.
- If either condition fails: no card is stored or revealed, "Finish Booking" is
  refused with "nothing was charged and no booking was recorded", the Admin
  banner and System Health say exactly why, and a health incident is recorded.
- Reveal's recent-sign-in step-up (§7) applies in every production-class
  environment **regardless** of how the vault was enabled.

## 6. Key rotation, compromise and recovery

### Routine rotation (no downtime, no lost cards)

1. Generate a new key: `openssl rand -base64 32`.
2. In Vercel set:
   - `CARD_ENCRYPTION_KEYS` = `k2:<new key>` (append: `k2:<new>,k1:<older>` on later rotations)
   - `CARD_ENCRYPTION_KEY_ID` = `k2`
   - keep `CARD_ENCRYPTION_KEY` (the legacy `v1`) **unchanged**, and keep every
     older key in the ring.
   Redeploy. New cards are now encrypted under `k2`; old cards still decrypt
   because their keys are still in the ring. System Health shows
   "N stored cards are not encrypted under the current key version".
3. Dry run against production (changes nothing, needs no key to count):
   `DATABASE_URL=… npm run cards:rotate`
4. Rotate: `DATABASE_URL=… CARD_ENCRYPTION_KEY=… CARD_ENCRYPTION_KEYS=… CARD_ENCRYPTION_KEY_ID=k2 npm run cards:rotate -- --apply`
   Each row is decrypted under its own key, re-encrypted under `k2`, verified by
   decrypting the result, and written with a compare-and-swap so a concurrent edit
   is never overwritten. Failures are listed by id + code and left untouched.
   An audit row `CARD_KEYS_ROTATED` records counts (no data). Safe to re-run.
5. Confirm System Health reports 0 cards on older keys.
6. **Do not delete the old key yet.** Database backups still contain ciphertext
   under it. Keep the old key (offline) until every backup that used it has
   expired, or you lose the ability to restore those backups' cards. Only then
   remove it from the ring.

### Suspected key compromise

Treat the key **and every card encrypted under it** as compromised (an attacker
with the key and a database copy can read them).
1. Rotate immediately as above (new key current), and rotate with `--apply`.
2. Notify per your obligations (card brands / acquirer / affected customers /
   regulators) — the decision belongs to the business, not this document.
3. Purge cards no longer needed (§10) and consider having customers re-enter
   cards. Rotating the key does **not** protect data an attacker already
   copied under the old key; only purging/expiry of the cards does.
4. Rotate the database credentials and all other secrets that shared exposure.

### Key loss / disaster recovery

- Cards under a lost key cannot be recovered. Recovery = customers re-enter
  cards. This is why an offline, access-controlled key escrow is required.
- Restoring a database backup requires the ring that was current when the backup
  was taken (§10).

## 6a. New environment variables and secrets policy

Never commit (Git-ignored `.env*`; set only in the host secret store):
`CARD_ENCRYPTION_KEY`, `CARD_ENCRYPTION_KEYS`, `IP_ENCRYPTION_KEY`,
`IP_HASH_KEY`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `GOOGLE_CLIENT_SECRET`,
`DATABASE_URL`, `CRON_SECRET`. Not secret (safe to show in health output):
`CARD_ENCRYPTION_KEY_ID`, `CARD_VAULT_MODE`.

## 7. Admin Reveal

Reveal is one narrowly scoped server action, `revealPaymentMethod`. Order of
checks, each failing closed and audited:

1. Authenticated **ACTIVE** session.
2. **Per-account rate limit** — 15 attempts / 10 min (counts every attempt).
3. **Explicit `payments.reveal` grant on an eligible role (Admin, Manager,
   Ticketing Agent). Admin included — no role has Reveal by role alone.** A
   user who can view a customer or edit a booking cannot reveal its card.
   Grants are made by an Admin on the Users page and are themselves audited.
4. **Object-level authorization**: the card's booking or contact must be one the
   account may see (IDOR/BOLA).
5. Card not removed/purged.
6. **Recent sign-in**: in production-class environments the account must have
   signed in within the last **15 minutes** (the session's creation time). An
   older or idle session is refused and told to sign in again. This is a real
   step-up built on the Google sign-in; it is **not** app-managed MFA — MFA is
   whatever the user's Google account enforces.
7. Decrypt (row-bound). A failure is audited (`CARD_DECRYPTION_FAILED`, fixed
   code) and returns a generic message.
8. Audit success, then return the number.

UI: masked by default (`•••• •••• •••• 1234`); after Reveal it is shown for **30
seconds**, hidden immediately when the tab is hidden or the window loses focus,
not selectable, copy/cut/context-menu blocked (the number is read and keyed in by
hand; nothing is placed on the clipboard by the app). It lives only in component
state and is cleared on unmount. The Server Action response is not cacheable
(`no-store`); the number is never in a URL, storage, log or analytics.

Hiding the button is **not** the control — every check above runs on the server.

## 8. Audit log

`AuditLog` rows for cards are written by `card-audit.ts`, one shape everywhere:
actor id, timestamp, action, record id, result, reason (fixed code), IP (only
when a trusted proxy resolved one), a user agent capped at 160 characters, and a
correlation id (Vercel request id when present). Values are scrubbed of
card-shaped digit runs; callers never pass a PAN.

Events: `PAYMENT_METHOD_CREATED / EDITED / REMOVED / PURGED`,
`PAYMENT_METHOD_REVEALED`, `PAYMENT_METHOD_REVEAL_DENIED`,
`PAYMENT_METHOD_MUTATION_DENIED`, `…_RATE_LIMITED` (repeated Reveal / mutation
attempts), `CARD_ENCRYPTION_FAILED`, `CARD_DECRYPTION_FAILED`,
`CARD_KEYS_ROTATED`, `PAYMENT_PERMISSIONS_CHANGED` (administrator changes).

**Tamper resistance:** a database trigger rejects `UPDATE` and `DELETE` of these
rows (entity `PaymentMethod`, actions `CARD_*` and `PAYMENT_*`). That resists
application bugs and application-level tampering. It does **not** stop someone
who can alter the database schema, or drop the table. For that threat, forward
the table to a write-once external log store — not done here.

Privacy: IP and user agent are stored because these are security events about who
touched a card; retention of `AuditLog` is indefinite by design (fraud
investigation). Review this against your privacy obligations.

## 9. Rate limits

Per-account (authenticated): Reveal 15 / 10 min; card add/edit/remove 30 / 15
min — over-limit is refused **and audited**. Public booking submission keeps its
existing per-IP limit (10 / 15 min), generous enough for retries and a shared
office IP. Sign-in is Google-token based (not password-guessable) and has no
lockout; abuse of an already-signed-in account is what the Reveal/mutation
limits and the recent-sign-in step-up address.

## 10. Backups, retention and deletion

**What the code can verify:** nothing about your database host's backups. Confirm
with the host (Aiven) and record: whether automated backups are on, their
retention, who can access/restore them, whether they are encrypted at rest, and
where the key ring is kept relative to them (it must **not** live with the
backup).

**Deletion behaviour (implemented):** removing a card (Admin only) archives the
row **and destroys the encrypted number** — `encryptedPan` becomes the tombstone
`cv2.purged`, `panPurgedAt` is set — so it can never be revealed or rotated.
`last4`, brand, expiry and payment history are kept. This is irreversible.

**Retention purge (implemented, opt-in):** `npm run cards:purge -- --archived`
and/or `--older-than-days N` (dry run unless `--apply`; audited per card).

**Scheduled purge (implemented, opt-in, OFF by default):** set
`CARD_RETENTION_DAYS` (whole number, 1–3650) and the daily cron
(`/api/cron/tasks`) destroys every stored card number created more than that many
days ago, plus any removed card not yet purged. It never runs unless configured,
and in production only when the cron is authenticated (`CRON_SECRET` set — an open
cron endpoint must never be able to trigger an irreversible purge). **This code
invents no retention period**; choosing one — and what event starts the clock
(the card's creation date is what is implemented) — is a business/legal decision.

**Recommended policy (a business decision — not enforced automatically):** keep a
full card number only as long as a supplier charge may still need it. Suggested:
purge the PAN once the booking's tickets are issued and payments confirmed, and
never later than 90 days after the booking; purge immediately when the customer
asks to remove a stored card; run the purge on a schedule you control.

**Backups and deletion:** deleting from the live database does **not** remove a
card from existing backups. Ciphertext in a backup is unreadable without the
ring that encrypted it; once *both* the backup has expired *and* the old key is
retired, the card is unrecoverable. Plan key retirement around backup retention
(§6 step 6).

## 11. Secrets and Git history (audited)

Searched all of Git history for: `CARD_ENCRYPTION_KEY` values, private keys,
`.env` files, database URLs, the production database host, the Google client
secret, and card-shaped numbers.

- `CARD_ENCRYPTION_KEY` (local value): **never committed.** No private keys. No
  `.env` file ever committed. The production database host and the Google client
  secret never appear. Database-URL-shaped strings in history are fake fixtures.
- **Finding:** the local development values of `GMAIL_TOKEN_ENCRYPTION_KEY`,
  `IP_ENCRYPTION_KEY` and `IP_HASH_KEY` are byte-identical to constants committed
  in test files in commit `355016f` (`gmail-token-encryption.test.ts`,
  `ip-vault.test.ts`, `ip-capture.test.ts`, `ip-encryption.test.ts`). They are
  therefore **public to anyone who can read the repository**. Whether the
  *production* deployment uses the same values cannot be determined from here.
  **Required action:** confirm in Vercel that production uses freshly generated
  values; if any production value equals a committed one, treat it as
  compromised: generate new values, re-link Gmail connections (token key), and
  accept that previously captured IP ciphertext is decryptable with the old key
  (re-encrypt or purge it). Never reuse a value that appears in a test file.
- **The GitHub repository is PUBLIC** (verified via the GitHub API), so those
  committed constants — and everything else in Git history — are readable by anyone.
  If any production secret equals a value that ever appeared in the repository, it
  is compromised today, not hypothetically.
- Test fixtures: a repository test rejects any card-shaped number that is not an
  official test number.
- Re-audited (values never printed): `DATABASE_URL`, `GOOGLE_CLIENT_SECRET`,
  `APP_BASE_URL` and `CARD_ENCRYPTION_KEY` (local values) appear **nowhere** in
  history; only the three keys above do. `.gitignore` ignores `.env*` except
  `.env.example`; no `.env` file is tracked; there is no CI configuration in the
  repository; `vercel.json` contains only the cron schedule. `CRON_SECRET` is not
  in the local `.env` and (per the configured variables) not in Vercel — see §5a.

## 12. Monitoring and health

- `GET /api/health` (public, no-store) exposes categories and booleans only:
  `environment`, `bookingCardStorage`, `cardVaultEnabled`, `cardVaultKey`
  (`configured|missing|invalid`), `cardVaultKeyVersion` (an id label such as
  `v1`/`k2`), `signerIpCapture`, `schema`, `pendingMigrations`, database
  latency. Never a key, ciphertext, PAN or connection detail.
- Admin **System Health → "Card vault & booking readiness"** adds: key ring
  problems (by name/id), keys in ring, stored cards and how many are on an older
  key (metadata only), and a standing WARNING in production that the vault is
  application-level and not PCI DSS-grade.
- Admin banner on every page while customers cannot book.

## 13. Remaining risks and PCI DSS gaps

Open, not fixed by this work:
- **No KMS/HSM**; key in app environment; no split knowledge/dual control
  (PCI DSS 3.6/3.7 key-management requirements).
- **The whole application is in scope** (PAN handled in memory by the app
  server): network segmentation, hardening, vulnerability management,
  penetration testing, quarterly scans, formal change control, access reviews,
  centralized log retention/monitoring (PCI DSS 1, 2, 6, 10, 11, 12).
- **No app-managed MFA** for administrative access (PCI DSS 8.4): only Google's.
- **CSP:** the card-entry page and every signed-in CRM page now use a strict
  per-request **nonce** policy (`script-src 'self' 'nonce-…' 'strict-dynamic'`) —
  injected inline script and inline event handlers are refused (verified in a real
  browser). **Still open:** `style-src` keeps `'unsafe-inline'` (inline style
  attributes from the UI libraries cannot carry a nonce); the public marketing and
  login pages keep the older policy with `'unsafe-inline'` scripts because
  statically generated pages cannot carry a per-request nonce; and a CSP does not
  stop an already-trusted script or dependency from misbehaving.
- **Audit log** append-only enforcement is at the application role/trigger level,
  not a write-once external store.
- **Backups**: encryption, retention and access are unverified from code.
- **JavaScript memory**: plaintext PAN strings cannot be zeroed.
- **Database TLS:** verification is now **available** (`DATABASE_SSL_CA` = the
  provider's CA certificate PEM, or `DATABASE_SSL_VERIFY=system`) but **off by
  default** because Aiven's CA is not in Node's trust store and enabling it without
  the certificate would break the connection. Until you set it, the connection is
  encrypted but the server's identity is not verified (System Health and
  `/api/health` `databaseTls` say so). The build-time migration step
  (`scripts/vercel-build.mjs`) still connects unverified.
- **Shared git-history test constants** (§11) may equal production keys.
- Staff who hold `payments.reveal` can read full numbers by design.

## 14. Production deployment checklist

1. Decide, in writing, that the business accepts application-level card storage
   and its PCI DSS scope/obligations.
2. Vercel env (mark sensitive): `CARD_ENCRYPTION_KEY` (or `CARD_ENCRYPTION_KEYS`
   + `CARD_ENCRYPTION_KEY_ID`), `IP_ENCRYPTION_KEY`, `IP_HASH_KEY` — all freshly
   generated, none equal to any value in Git (§11).
3. Store an offline, access-controlled copy of every key.
4. Set `CARD_VAULT_MODE=application-encryption-risk-accepted`. Do **not** rely on
   `APP_ENV`.
5. Redeploy; confirm `/api/health`: `environment: "production"`,
   `cardVaultEnabled: true`, `bookingCardStorage: "available"`,
   `cardVaultKey: "configured"`, `schema: "current"`.
6. Grant `payments.reveal` explicitly and only to the few people who need it
   (Users page). Admins have no Reveal by default.
7. Confirm database backup settings (§10) and record them.
8. Do one test booking with an official test card number on a test quote;
   Reveal it as a granted, recently-signed-in Admin; confirm the audit entries.
9. Agree the retention policy (§10) and schedule the purge.
10. Rehearse a key rotation on a copy before you need it.

## 15. Migrating an existing deployment (only `CARD_ENCRYPTION_KEY` in Vercel)

**Verified against the source and proven by `card-vault-production-profile.test.ts`:**

- `CARD_ENCRYPTION_KEY` is read by `card-keyring.ts` only. It **is** the legacy key,
  with the fixed key id **`v1`**. It decrypts (a) every card stored in the original
  format and (b) every `cv2.v1.…` envelope.
- With only that variable set, `v1` is automatically the *current* key. **No key
  ring, no key id and no re-encryption are needed** for the vault to work and for
  every existing card to stay readable. Nothing is generated, renamed or moved.
- `CARD_ENCRYPTION_KEY_ID` and `CARD_ENCRYPTION_KEYS` exist for **future rotation**.
  They are optional until you rotate.

The minimum change to take bookings is therefore **one new variable**:
`CARD_VAULT_MODE=application-encryption-risk-accepted` (the only accepted value;
surrounding whitespace is ignored, any other spelling — `true`, `staging`, wrong
case — leaves the vault closed).

### Exact Vercel table (production)

| Variable | Now | Action | Value | Why |
|---|---|---|---|---|
| `APP_ENV` | `production` | **KEEP** | `production` | Correct. Only `production` has any effect; never use `staging` to open the vault. |
| `CARD_ENCRYPTION_KEY` | set | **KEEP — DO NOT TOUCH** | (unchanged, secret) | It is key `v1` and may protect real cards. Removing or replacing it strands them. |
| `CARD_VAULT_MODE` | absent | **ADD** | `application-encryption-risk-accepted` | The explicit, deliberate opt-in (only accepted value). |
| `CARD_ENCRYPTION_KEYS` | absent | **DO NOT ADD YET** | — | Only needed at the first rotation (§6). Not a rename of `CARD_ENCRYPTION_KEY`. |
| `CARD_ENCRYPTION_KEY_ID` | absent | **DO NOT ADD YET** | — | Defaults to `v1` (the existing key). Only required together with `CARD_ENCRYPTION_KEYS`. |
| `IP_ENCRYPTION_KEY`, `IP_HASH_KEY`, `GMAIL_TOKEN_ENCRYPTION_KEY` | set | **KEEP — DO NOT TOUCH** (but see §11) | (unchanged) | Changing them breaks stored IP history / Gmail connections. If production equals a value found in Git, rotate deliberately — a separate task per key. |
| `GOOGLE_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `DATABASE_URL`, `APP_BASE_URL`, `INITIAL_ADMIN_EMAIL` | set | **KEEP — DO NOT TOUCH** | — | Unrelated to the vault. |
| `CRON_SECRET` | absent | **ADD (recommended)** | a fresh random secret (`openssl rand -base64 32`) | Without it the cron endpoint is open; required before any scheduled purge will run in production. |
| `DATABASE_SSL_CA` | absent | **ADD (recommended)** | the Aiven project CA certificate (PEM) | Turns on database TLS **verification** (§13). Test on a preview first. |
| `CARD_RETENTION_DAYS` | absent | **ADD only after a business decision** | whole number of days | Enables the daily card purge. Off = nothing is purged automatically. |

Optional, equivalent form (only if you want the key visible in the ring now):
`CARD_ENCRYPTION_KEYS=v1:<the same existing key>` + `CARD_ENCRYPTION_KEY_ID=v1`.
The id **must be `v1`**: a ring that lists the existing key under any other id and
drops `CARD_ENCRYPTION_KEY` makes every existing card undecryptable (`KEY_UNKNOWN`
— proven in the tests). `CARD_ENCRYPTION_KEY` may be removed later **only** if the
ring holds that key as `v1`. There is no reason to do either now.

**Sequence:** add `CARD_VAULT_MODE` → redeploy → check `/api/health`
(`environment: production`, `cardVaultState: available_risk_accepted`,
`bookingCardStorage: available`, `cardVaultKeyVersion: v1`) → open System Health
("Card vault & booking readiness": stored cards, "on an older key" should be 0
or explained) → grant `payments.reveal` to the people who need it.

**Rollback:** delete `CARD_VAULT_MODE` and redeploy. The vault closes (customers'
Finish Booking is refused cleanly, nothing is stored); no data is touched and
existing cards stay encrypted. Never roll back by changing or deleting
`CARD_ENCRYPTION_KEY`.

## 16. Rotation, step by step (unchanged mechanism, restated)

1. **Add a key:** `CARD_ENCRYPTION_KEYS=k2:<new key>` (append: `k2:<new>,k1:<older>`).
   **Keep** `CARD_ENCRYPTION_KEY` (`v1`) and every older key.
2. **Make it current:** `CARD_ENCRYPTION_KEY_ID=k2` (required whenever a ring is used).
   Redeploy. New cards use `k2`; old cards still decrypt.
3. **Rotate cards:** run from a trusted machine with the same variables and
   `DATABASE_URL`: `npm run cards:rotate` (dry run — prints counts per key id, writes
   nothing), then `npm run cards:rotate -- --apply`. Verified properties:
   - *dry-run default*; *idempotent* (a second run rotates 0 rows);
   - *interruption-safe*: each row is its own compare-and-swap write, so an
     interrupted run leaves every row either fully old or fully new; re-run to finish;
   - each row is decrypted under its own key, re-encrypted, **re-decrypted and
     compared** before it is written; a failing row is left untouched and reported by
     id + fixed code;
   - an audit row `CARD_KEYS_ROTATED` (counts only) is written on \`--apply\`.
4. **Verify:** System Health shows "cards on an older key: 0" (or re-run the dry run:
   \`toRotate\` empty, \`failed\` empty).
5. **How long old keys stay:** until (a) 0 stored cards use them **and** (b) every
   database backup/snapshot taken while they were in use has expired or been
   destroyed (§10). Then, and only then, retire one key at a time and re-check
   System Health. When in doubt, keep the key (offline).
6. Never rotate automatically; never delete `CARD_ENCRYPTION_KEY` merely because it
   is old.

## 17. Step-up authentication for Reveal — evaluation

**Today (implemented):** a sign-in within the last 15 minutes (session creation
time), applied in every production-class environment however the vault was enabled
(`APP_ENV` cannot bypass it). It is real but limited: it proves a recent Google
sign-in, not possession of a second factor at the moment of Reveal, and a stolen
*fresh* session could Reveal within the window (bounded by the per-account rate
limit and audited).

**Options, and why none is faked here:**

| Option | Strength | What it needs |
|---|---|---|
| **WebAuthn / passkeys / security keys** (recommended) | Phishing-resistant; per-Reveal user-presence | A WebAuthn server library (new dependency), a credential table, registration + assertion flows, origin/RP-ID configuration, credential recovery/reset procedure with dual approval. |
| **TOTP (RFC 6238)** (acceptable fallback) | Second factor, phishable | An enrolment UI, TOTP secrets encrypted at rest (own key), verification with replay protection and attempt limits, recovery codes, an audited admin reset. |

Both need **business decisions** (who must enrol, what happens when a device is
lost, who may reset) and new persisted secrets, so they were not bolted on without
that agreement — a half-built MFA that can be bypassed by an unenrolled account or
a reset path is worse than an honest "not implemented". Recommended next step:
WebAuthn for every account holding `payments.reveal`, verified per Reveal with a
5-minute window, in addition to (not instead of) the current checks.

## 18. Health states

`/api/health` `readiness.cardVaultState` and System Health "Vault state":

| State | Meaning | System Health severity |
|---|---|---|
| `disabled` | Production-class and `CARD_VAULT_MODE` not set to the phrase (customers cannot book — accurate, deliberate default) | CRITICAL |
| `misconfigured` | Key ring missing/invalid (names only, never values) | CRITICAL in production, else WARNING |
| `available` | Local/test with a valid ring | HEALTHY |
| `available_risk_accepted` | Production, explicitly enabled, valid ring — application-managed encryption in use | **WARNING** (compliance/security notice, not a customer-blocking incident) |

A runtime failure while storing a card (for example a database fault) is not a
configuration state; it raises the `BOOKING_PAYMENT_UNAVAILABLE` health incident
and the customer is told nothing was charged and no booking was recorded.
