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
| **CVV / CVC / security code** | **Temporarily, encrypted, ≤ 24 h** (Sensitive Authentication Data) | `PaymentMethodCvv.encryptedCvv` — and nowhere else | Typed into the booking form (React state), sent once with Finish Booking, format-checked, then **encrypted at once** (card-vault envelope, its own AAD) and written only to the dedicated `PaymentMethodCvv` table. **Never plaintext**, never on `PaymentMethod`/`Booking`/any ordinary record; never cached, logged, audited, e-mailed, put in a URL or browser storage. Destroyed no later than **24 hours after the Booking Form was signed**, and earlier when the payment is recorded as charged or cancelled or an Admin destroys it. Revealed only by the dedicated **Admin-only** action. Full description, limits and PCI position: **section 19**. |
| PIN, magnetic-stripe/track data | Never | nowhere | Same. |
| PAN fingerprint / hash / search index | **No** | nowhere | There is **no product requirement to look a card up by its number**, so none is built (an HMAC index would only add another PAN-derived value to protect). If one is ever required it must be a keyed HMAC-SHA-256 (never a plain hash) under its own key, stored separately and never returned to a client. A guard test fails if a fingerprint column appears without this document being revisited. |

Field-level rationale: PCI DSS requires the PAN to be rendered unreadable
wherever it is stored; it permits cardholder name and expiry to be stored, with
protection. The sensitive authentication data (CVV, PIN, track data) may not be
retained after authorization at all. PIN and track data are therefore never
collected. The security code is the one exception, and it is held only before
authorization, encrypted, for at most 24 hours — see section 19.

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
4. Rotate: `DATABASE_URL=… CARD_ENCRYPTION_KEY=… CARD_ENCRYPTION_KEYS=… CARD_ENCRYPTION_KEY_ID=k2 npm run cards:rotate -- --apply --confirm`
   (`--apply` alone is refused: the tool insists on `--confirm` and prints the preconditions — a verified database backup, every old key kept in the ring, a dry run reviewed. A canary batch is possible first with `--ids=<id>,<id>`.)
   Each row is decrypted under its own key, re-encrypted under `k2`, verified by
   decrypting the result, and written with a compare-and-swap so a concurrent edit
   is never overwritten. Failures are listed by id + code and left untouched.
   An audit row `CARD_KEYS_ROTATED` records counts (no data). Safe to re-run.
5. Confirm System Health reports 0 cards on older keys, then run the read-only proof:
   `DATABASE_URL=… <same key variables> npm run cards:rotate -- --verify`. It decrypts every stored card under its own key (discarding the value, writing nothing), counts rows per key id, and lists `retirableKeyIds` — the ring keys that **no row depends on any more**. A single undecryptable row makes it exit non-zero with `safeToRetireListedKeys: false`; then **no key may be retired**.
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

## 12a. Obtaining the official Aiven CA certificate (manual — cannot be done from this repository or this session)

`databaseTls: unverified` means the connection is encrypted but the server's
certificate is not checked against a trusted authority, so a network attacker
who could intercept the connection could impersonate the database. Fixing this
needs **Aiven's own CA certificate for this specific project's PostgreSQL
service** — a value that only exists in your Aiven account. Nothing in this
codebase contains it, there is no project id or service name recorded anywhere
in the repository to derive it from, and this session has no Aiven
credentials, API token, or browser access to your account. **I did not obtain
or verify this certificate, and did not set `DATABASE_SSL_CA`.** Do not accept
a certificate from anywhere other than your own Aiven console/CLI/API for
this project — a CA certificate copied from a website, a different Aiven
project, or an example in documentation would not match this database's
server and TLS verification would simply fail (or, worse, silently validate
against the wrong authority if something else on the connection also matched).

**To obtain it yourself:**

- **Aiven console:** sign in → open your project → open the PostgreSQL
  service this app's `DATABASE_URL` points at → its **Overview** page's
  "Connection information" panel has a **CA Certificate** (sometimes labelled
  "SSL Certificate") download/copy control. Aiven has changed console layouts
  before, so if it is not there, check the service's **Overview**, **Connection
  information**, or **Security** section — copy this project's document
  (`ca.pem`), not a generic Aiven CA you find elsewhere.
- **Aiven CLI**, if you have it set up: `avn service get <service-name> --project <project-name> --format '{ca_cert}'` writes the same certificate.
- **Aiven API**, if you use it directly: the service-details endpoint returns a `ca_cert` field.

Once you have the PEM certificate, paste it (the full `-----BEGIN
CERTIFICATE-----`…`-----END CERTIFICATE-----` block) into Vercel's
`DATABASE_SSL_CA` for this project, marked *Sensitive* isn't required (a CA
certificate is public information, not a secret, but treat the variable
normally), redeploy, and confirm `/api/health` → `databaseTls: "verified"` and
that the app still connects. Test on a preview deployment first — a wrong or
mismatched certificate makes every database connection fail closed rather than
silently staying unverified.

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

### Live production status (read from the public `/api/health`, 2026-10-05 — no secret is exposed there)

`environment: production`, `cardVaultState: available_risk_accepted`, `cardVaultEnabled: true`, `bookingCardStorage: available`, `cardVaultKey: configured`, `cardVaultKeyVersion: v1`, `databaseTls: verified`, `signerIpCapture: enabled`, `schema: current`, `pendingMigrations: 0`. So `CARD_VAULT_MODE` **is** set in production, the current key is the legacy key `v1` (no ring in use), database TLS verification is on (a CA is configured) and the trusted proxy resolves. The "Now" column below describes the state at the time this section was written.

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
| `DATABASE_SSL_CA` | absent | **ADD (recommended) — manual, from Aiven** | the Aiven project CA certificate (PEM) — **obtain this yourself; nothing in this repository or session can produce or verify it** (see §12a) | Turns on database TLS **verification**. Test on a preview first. |
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
   nothing), then `npm run cards:rotate -- --apply --confirm`. Verified properties:
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

## 16a. Converting a legacy-format card to the current v1 envelope (no new key)

This is a **different, smaller operation than §16** — it does not add a key,
does not touch `CARD_ENCRYPTION_KEY`, and does not change which key protects
anything. A card stored before the versioned envelope existed
(`base64(iv‖tag‖ciphertext)`, no key id, no row-binding) is re-wrapped as
`cv2.v1.…` **under the exact same `CARD_ENCRYPTION_KEY`**, gaining the current
format's row-binding (the ciphertext can no longer be copied into a different
row and decrypt there) with nothing else changing. `npm run cards:rotate`
handles this automatically: when only `CARD_ENCRYPTION_KEY` is configured (no
`CARD_ENCRYPTION_KEYS`/`CARD_ENCRYPTION_KEY_ID`), the ring's one key is id
`v1`, so "rotate to the current key" and "convert to the current format" are
the same run.

**Procedure (operator-run — this tool has no production database
credentials):**

```
DATABASE_URL=<production DATABASE_URL> CARD_ENCRYPTION_KEY=<production key> npm run cards:rotate
```

Confirm the dry-run output before doing anything else: `currentKeyId: "v1"`,
`toRotate: { "legacy": N }` (no `k2` or other id — only `CARD_ENCRYPTION_KEY` is
set), `failed: []`. Then re-run with `-- --apply --confirm`. Verify with
`npm run cards:rotate` again (dry run): `alreadyCurrent` now covers those rows,
`toRotate: {}`. System Health → "Card vault & booking readiness" should show
"Cards on an older key / legacy format: 0" on the next load.

**Rehearsed and verified in this repository's own disposable local database**
(never against production, which this session cannot reach) before recommending
this: seeded one card in the exact legacy format, ran the dry run (correctly
reported `toRotate: {"legacy":1}`, wrote nothing), ran `--apply` (`rotated: 1`,
`failed: []`), then confirmed directly — the row now reads `cv2.v1.…`, still
decrypts to the original value under the same key, no plaintext PAN appears
anywhere in the row, an audit row (`CARD_KEYS_ROTATED`, counts only) was
written, and a second dry run reports the row `alreadyCurrent` with nothing
left `toRotate`. This proves the mechanism is safe for exactly the production
scenario (one legacy card, only `CARD_ENCRYPTION_KEY` configured); it is not a
substitute for running it against production, which only the operator can do.

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

## 19. CVV/CVC 24-Hour Retention and Reveal (temporary, encrypted, Admin-only)

**Status: application-level controls implemented; formal PCI DSS / acquirer / payment-brand / QSA validation remains required. This section does not claim, and the feature does not establish, PCI DSS compliance.**

### 19.1 What it is and why it exists
The CVV/CVC is **Sensitive Authentication Data (SAD)**. PCI SSC guidance permits it to be collected and held *before* authorization (and requires strong encryption while it is) but forbids retaining it *after* authorization, even encrypted; payment brands and acquirers may impose stricter rules. Compass Tools has no payment gateway: an Administrator charges the card **by hand** in the supplier's / acquirer's terminal. To make that possible the code the customer typed into the Booking Form is kept — **only** for the pending manual-payment workflow — in a dedicated, short-lived, encrypted record and then destroyed. Nothing about this is a gateway, a tokenization service or a certified payment application.

### 19.2 The lifecycle
```
Booking Form signed                    (authoritative instant = the one stored as Quote.signedAt / Booking.termsAcceptedAt)
  → code format-checked, encrypted (card-vault envelope, own AAD), written to PaymentMethodCvv   expiresAt = signedAt + 24 h
  → Admin opens the Booking → Payment → "Reveal CVV/CVC" (repeatable inside the window; shown 30 s)
  → Admin charges the card by hand → records the payment
  → destroyed:   payment recorded as SUCCEEDED / workflow CONFIRMED      → ciphertext set to NULL immediately
                 workflow CANCELLED, or the card is removed                → destroyed
                 Admin presses "Destroy CVV/CVC" (confirmation dialog)     → destroyed
                 24 hours after signing, whatever else happened            → deleted (daily cron) and refused/deleted at reveal time
```
* **The 24-hour limit is fixed.** `CVV_RETENTION_MS` is a constant in `src/server/security/booking-cvv.ts`; no environment variable, setting or UI changes it, and there is no "unlimited" mode. `expiresAt` is written once at creation. **Nothing extends it**: revealing, reloading, editing the booking, reassigning it, changing the quote, recording a failed attempt or recording a payment never writes to it, and the database itself rejects any row whose `expiresAt` is not exactly `signedAt + 24 hours` (`PaymentMethodCvv_expires_24h_after_signing`).
* **Payment states (from the real state machine).** `CONFIRMED` (set by *Record payment → Succeeded* or by the status control) is the terminal success state and destroys the code. `CANCELLED` is terminal and destroys it. `FAILED` is retryable — a failed attempt does **not** destroy it and does **not** extend the deadline (the Admin may retry within the 24 hours). `AUTHORIZED` is, in this codebase, the intermediate "supplier charge attempted" state (see `PaymentWorkflowStatus` in `schema.prisma`), not a terminal one, so it does not destroy the code; the 24-hour deadline still applies to it.
* **Creation-time enforcement.** No record is created when there is no code, when the signing time is invalid or in the future, when the window would already be over, or when the vault is unavailable (the booking and card are still saved; System Health shows `BOOKING_CVV_NOT_RETAINED`, and the Admin sees "no longer available").
* **Expiry is enforced three ways.** (1) The daily cron (`/api/cron/tasks`) deletes every record past `expiresAt`, idempotently; (2) every reveal checks `now < expiresAt` first and deletes a stale record on the spot; (3) the database constraint above makes a longer window unrepresentable. The limit therefore holds even if a cron run is late.

### 19.3 Storage and encryption
* Table `PaymentMethodCvv` (one row per card, keyed by `paymentMethodId`, `ON DELETE CASCADE`): `encryptedCvv`, `signedAt`, `expiresAt`, `destroyedAt`, `destroyedReason`, `createdAt`. **No plaintext column exists**; the `PaymentMethod`, `Booking`, `Quote`, `Contact` and `Lead` tables hold no security-code field (guard-tested; the `retainedSecurityCode` field on the `PaymentMethod` Prisma model is a *virtual* relation pointer required by Prisma for the foreign key — it is not a column and cannot carry a value).
* Same key ring, same `cv2.<keyId>.<iv‖tag‖ciphertext>` AES-256-GCM envelope and fail-closed vault gate as the card number, but with its **own AAD domain** (`compass-card-vault|cv2-cvv|<paymentMethodId>`): a code's ciphertext cannot be decrypted as a card number, as another card's code, or from another row. The database CHECK `PaymentMethodCvv_encryptedCvv_envelope` rejects anything that is not an envelope (or NULL).
* **Key rotation:** the rotation script does not touch these rows — they never outlive 24 hours, so a retired key needs to remain available only until the last record encrypted under it has expired (24 h). Nothing in the rotation or `--verify` tooling was changed.
* The ciphertext column is omitted from every Prisma read (`src/lib/prisma.ts`) — a **secondary** defence. The primary controls are below.

### 19.4 Who can reveal it and how
Strictly **Admin only**. `canRevealBookingCvv` = role `ADMIN` **and** the explicit `payments.reveal` grant (the card-number Reveal's own grant); another role's card-reveal permission never carries over. The server action `revealBookingCvv(bookingId, paymentMethodId)` (`src/server/actions/booking-cvv.ts`) re-checks everything — the UI is never the control:

| Role | Reveal / Destroy CVV/CVC |
|---|---|
| Admin with `payments.reveal`, active, recent sign-in, own company, booking visible | **Allowed** |
| Admin without the grant · inactive Admin · Admin of another company | Refused |
| Manager · Ticketing Agent · Travel Agent · Flight Expert · Marketing Agent (with or without card-reveal rights) | Refused — before the rate limiter, the booking lookup or any decryption |
| Not signed in | Refused |

Order of checks: active session → Admin + grant → dedicated rate limit `CVV_REVEAL` (10 per 10 minutes per account, counts every attempt, its own bucket, applied **before** any decryption) → the booking is one the account can see **and** in its own company → the card belongs to **that** booking → sign-in within the last 15 minutes (same step-up as the card Reveal) → the record exists, is not destroyed and has not expired → decrypt server-side → return the code. One request is *Booking + that booking's card*; there is no list, search, by-contact, by-lead or bulk variant. The code is never part of any Booking / Quote / Contact / Lead read, never in the page's data (the Booking page passes only "available until …" / "not available" to an Admin, and nothing at all to anyone else), and the ciphertext is never returned to a browser. The UI shows it for 30 seconds (hidden also on tab change / blur / unmount), keeps it in component state only, blocks copy, and never writes it to storage, a URL or analytics. **Hiding it is not destroying it**: the stored value remains until one of the destruction events above.

### 19.5 Audit
`CVV_REVEALED`, `CVV_REVEAL_DENIED` (with a reason category such as `NOT_ADMIN`, `MISSING_PERMISSION`, `BOOKING_NOT_ACCESSIBLE`, `CARD_NOT_ON_BOOKING`, `RECENT_LOGIN_REQUIRED`, `EXPIRED`, `DESTROYED`), `CVV_REVEAL_RATE_LIMITED` and `CVV_DESTROYED` (reason `PAYMENT_CONFIRMED`, `PAYMENT_CANCELLED`, `CARD_REMOVED`, `ADMIN_DESTROYED`, `EXPIRED`) go to the append-only card audit log with actor, booking, company, card id, result and the usual request context. **Never** the code, the ciphertext, the card number or a key. Logs carry only fixed tags (`[booking] CVV_NOT_RETAINED (…)`), never a value; no e-mail, activity entry, notification or health incident contains it (source- and database-scanned by tests).

### 19.6 Destruction, backups and what the application cannot promise
The application guarantees that **the live database no longer holds the code** after destruction: destruction sets the ciphertext to `NULL` (and the daily cleanup / reveal-time check deletes the row); no application path can recover it afterwards. It does **not** and cannot claim that every copy is gone:
* **PostgreSQL** keeps superseded row versions until vacuum and replays them from the write-ahead log; **replicas, snapshots, point-in-time-recovery archives and disaster-recovery copies** taken during the 24 hours may contain the encrypted value (and, if the key ring is also available, it could be decrypted) until those copies expire. Backup retention, replica lag, snapshot schedules and who may restore them are **infrastructure controls this repository cannot see or set**. Treat the provider's backup retention as part of the PCI assessment; if retention is long, the CVV exposure window in backups is long.
* The key ring lives in the same application as the ciphertext's reader (see section 13): anyone who can read both the database and the application environment can decrypt every un-destroyed record.

### 19.7 What this does NOT establish (see also 19.11)
This is a set of application-level controls. It does not by itself make the environment PCI DSS compliant. **REQUIRES PCI/QSA/ACQUIRER REVIEW**: whether holding the code before a manual charge is acceptable under the merchant's validation type, acquirer agreement and each card brand's rules; the length of backup / replica retention; the key-management model (no HSM/KMS, no dual control); and the scoping of the CRM, its database and its staff terminals. Retention can be switched off at any time by removing the capture (nothing else depends on it): the Booking Form would then validate and drop the code exactly as before.

### 19.8 Operational consequence — exactly 24 elapsed hours, no weekend, no Monday, no renewal
The retention window is **calendar/elapsed time: `signedAt + exactly 24 hours`**. It does **not** pause, extend or reset for a Friday, Saturday, Sunday, holiday or weekend, or because an Admin viewed the CVV/CVC, a payment attempt succeeded or failed, a payment was retried, the Booking or Quote was edited, the Booking was reopened or it was reassigned. There is **no** weekend exception, **no** Monday exception, **no** business-day calculation, **no** 48/72/168-hour fallback, **no** Admin renewal and **no** configuration or environment variable that changes it. Revealing never writes to the record.

> **Example.** A Booking Form signed **Friday at 5:00 PM** has its CVV/CVC expire **Saturday at 5:00 PM**. It will **not** remain available through the weekend for a Monday manual charge. Saturday 4:59 PM it can still be revealed; from Saturday 5:00 PM — and on Sunday and Monday — it cannot.

**The CVV/CVC may therefore be unavailable for a Monday manual charge if the Booking Form was signed more than 24 hours earlier.** The system intentionally destroys it after 24 hours and provides no weekend extension or Admin renewal mechanism. This is a deliberate security/business tradeoff, not a defect. If the Admin needs the CVV/CVC for a charge, the Booking Form must be handled within the 24-hour window, or the payment workflow must use another mechanism the business and its acquirer permit. Nothing in this system should be changed to circumvent the window; if the business decides Monday charging needs a different process, that is a separate business/security decision and a separate change.

When someone tries to reveal an expired value the screen says that the CVV/CVC is no longer available because the 24-hour retention period has expired (and the Payment section shows "CVV/CVC no longer available — it is kept for at most 24 hours after the Booking Form is signed"); the previous value is never decrypted or returned, and a stale record is deleted. Tests pin this with synthetic timestamps (signed Friday 17:00 → Saturday 16:59 permitted, 17:00 / 17:01 / Sunday / Monday refused; unaffected by a Friday reveal, a failed payment, a Saturday edit or reopen; exactly 86,400,000 ms across a daylight-saving change).

### 19.9 Reveal Card Information and Reveal CVV/CVC are separate capabilities
Both controls sit in **Quotes → Bookings → Booking → Payment**, the CVV/CVC control immediately below the card one. They are **different sensitive-data capabilities** with nothing shared except the key ring and the audit log's append-only table:

| | Reveal Card Information (card number) | Reveal CVV/CVC |
|---|---|---|
| Server action | `revealPaymentMethod` (unchanged) | `revealBookingCvv` / `destroyBookingCvv` (new) |
| Who | roles eligible for Reveal (Admin, Manager, Ticketing Agent) **with** the explicit `payments.reveal` grant | **Admin only**, **and** the `payments.reveal` grant |
| Storage | `PaymentMethod.encryptedPan` (kept until purged by retention) | `PaymentMethodCvv.encryptedCvv` (≤ 24 h) |
| AAD | `compass-card-vault\|cv2\|<id>` | `compass-card-vault\|cv2-cvv\|<paymentMethodId>` |
| Rate limit | `CARD_REVEAL` 15 / 10 min | `CVV_REVEAL` 10 / 10 min (own bucket) |
| Audit | `PAYMENT_METHOD_REVEALED` / `_REVEAL_DENIED` / `_REVEAL_RATE_LIMITED` | `CVV_REVEALED` / `CVV_REVEAL_DENIED` / `CVV_REVEAL_RATE_LIMITED` / `CVV_DESTROYED` |
| Lifetime | until the card is removed / purged | fixed 24 h after signing; destroyed sooner on payment / cancel / removal / Admin destroy |

**Permission to reveal the card number does not by itself grant CVV/CVC access** (a Manager or Ticketing Agent holding `payments.reveal` is refused). Revealing one never reveals, extends or consumes the other, and the existing card reveal is unchanged.

### 19.10 Infrastructure retention — not verified from this repository
Application deletion does **not** erase historical copies. The encrypted value (and, with the key ring, its plaintext) may persist in **PostgreSQL WAL, replicas, database snapshots, point-in-time-recovery archives, backups and disaster-recovery copies** for as long as the hosting provider retains them. This repository and its automation **cannot inspect** the production database's backup retention, PITR window, replica or snapshot retention, encryption at rest, or who can restore or read them, and none of those values is stated here. **REQUIRES MANUAL ACTION**: the database administrator must record (from the provider's console / contract) the backup and PITR retention, replica and snapshot retention, encryption-at-rest setting and the access controls over restores, and the PCI assessment must take the CVV exposure window in those copies into account.

### 19.11 Compliance statement
**This implementation provides application-level security controls but does not establish PCI DSS compliance.** It is not PCI compliant, certified or validated by virtue of this code. **REQUIRES PCI/QSA/ACQUIRER REVIEW** — whether holding the code before a manual charge is permitted for this merchant, acquirer and card brands; backup/replica retention; the key-management model; and scoping.
