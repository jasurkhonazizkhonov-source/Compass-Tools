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
- Test fixtures: a repository test rejects any card-shaped number that is not an
  official test number.

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
- **CSP allows `'unsafe-inline'` scripts** (required by Next.js hydration, no
  nonce plumbing): an XSS bug could read a card as it is typed. The CSP still
  blocks framing, plugins, foreign form targets and unexpected origins.
- **Audit log** append-only enforcement is at the application role/trigger level,
  not a write-once external store.
- **Backups**: encryption, retention and access are unverified from code.
- **JavaScript memory**: plaintext PAN strings cannot be zeroed.
- **Database TLS**: the pool connects with `rejectUnauthorized: false` (managed
  DB CA not in Node's trust store) — encrypted but not identity-verified.
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
