# IP Vault — data protection & compliance notes

This documents what the IP vault (`IpCapture` — see its schema doc comment
in `prisma/schema.prisma`) technically does, so a real privacy/legal
reviewer for each deployed company can make the actual policy decisions.
**Nothing in this file is legal advice** — it's a factual description of
the system, written so someone qualified to answer "is this lawful for us,
here, given our jurisdiction and customers" has what they need to answer
that, not an attempt to answer it here. Same stance the code itself
already takes (see `ipRetentionDays()`'s own comment in
`src/server/actions/booking-security.ts`): retention/lawful-basis is a
business/legal decision this codebase deliberately does not make on its
own.

## What is captured, and when

A signer's IP address (and User-Agent string) is captured server-side —
never accepted from the client — at three points:

| Event | Where | Code |
|---|---|---|
| A customer submits a new booking form | `submitBooking` | `src/server/actions/booking.ts` |
| A customer submits an exchange booking form | Same `submitBooking` (an exchange quote's `originalQuoteId` is set) | `src/server/actions/booking.ts` |
| A customer confirms a cancellation | `confirmCancellationByCustomer` | `src/server/actions/cancellation.ts` |

An IP address is personal data under most data-protection regimes (GDPR
Recital 30 explicitly names IP addresses; CCPA's "personal information"
definition is broad enough to include them too) — treat it accordingly.

## Where it's stored, and how it's protected

- **`Signature.ipAddress`** — one plaintext value per Booking (the
  original signing event only), used by the pre-existing single-booking
  Reveal UI (`BookingIpReveal`). Not encrypted at rest.
- **`IpCapture`** (the vault) — one row per signing event, **encrypted at
  rest** (AES-256-GCM, `src/server/security/ip-encryption.ts`), with a
  separate one-way HMAC blind index (`ipHash`/`subnetHash`) used only for
  exact-match search, never for decryption.
- Both are visible only to a narrow, explicitly-permissioned set of
  back-office roles (`canRevealBookingIp` / `canAccessIpVault` —
  Admin always, Manager/Ticketing Agent with an explicit granted
  permission), gated by row-level company/ownership scoping, a step-up
  re-authentication check, and rate limiting.
- Every reveal, search, history view, export, and suspicious-flag/note
  change is written to `AuditLog` (`entityType: "IpCapture"` /
  `"Booking"`), including denied attempts — see the IP Vault Access
  Audit Log section on the `/ip-vault` page (Admin-only).
- Application logs never contain the raw IP — see `request-ip.ts`'s and
  `ip-capture.ts`'s own comments on this; the correlation log in
  `submitBooking` was found during this work to violate that and was
  fixed to log only `ipCaptured: boolean`.

## Retention

- `Signature.ipAddress` has no built-in expiry — it lives as long as the
  Booking row does.
- `IpCapture` rows are **soft-deleted only** (`softDeletedAt`) — nothing
  in this app currently hard-deletes one. There is no automated retention
  job today.
- **Pass 33 — `BOOKING_IP_RETENTION_DAYS` has been removed entirely and no
  longer has any effect.** It never deleted or expired data (see above);
  the one thing it used to do — deny `revealBookingIp` for a booking older
  than the configured window, even to a fully-authorized user — has also
  been removed, per an explicit product decision that booking submission
  IP information must be retained, and remain revealable to authorized
  staff, indefinitely with no automatic age-based restriction of any kind.
- **This means: as shipped, IP data is retained indefinitely, and remains
  revealable to authorized staff indefinitely, unless a deployment
  operator adds a real, explicit, deliberate deletion/anonymization
  process.** Whether indefinite retention is acceptable depends entirely
  on the deployed company's own jurisdiction, customer base, and
  data-retention policy — this is a business/legal decision this codebase
  does not and cannot make on your behalf. If your organization determines
  indefinite retention is NOT acceptable, that must be implemented as a
  genuine, deliberate, out-of-band data-management process (e.g. an
  administrator-triggered or explicitly-scheduled deletion/anonymization
  job you build and own) — never an automatic age-based deletion baked
  into this application's ordinary request-serving code paths.

## What a real deployment still needs to decide (not provided here)

1. **Lawful basis for processing** (GDPR) — most likely "legitimate
   interest" (fraud prevention) for the IP vault specifically, but that
   requires a genuine legitimate-interest assessment (balancing test)
   your own counsel/DPO should perform, not a default this codebase can
   assert on your behalf.
2. **Retention period** — the application's own default, as of Pass 33, is
   indefinite retention with no automatic age-based expiration
   (`BOOKING_IP_RETENTION_DAYS` no longer exists as a control point). If
   your organization's jurisdiction/policy requires a finite retention
   period instead, that is not something this codebase will enforce for
   you — build and own a genuine, deliberate, explicitly-authorized
   deletion/anonymization job for `IpCapture`/`Signature.ipAddress` rows
   past whatever point your own legal/privacy review determines, separate
   from and never coupled to the application's ordinary request-handling
   code.
3. **Privacy notice language** — the company's own customer-facing privacy
   policy should disclose that submission IP addresses are collected for
   fraud-prevention purposes at the point of booking/cancellation
   confirmation. Suggested starting point (have counsel review before
   publishing):

   > When you submit a booking or confirm a cancellation, we record the
   > IP address and browser information associated with that submission.
   > We use this information solely for fraud prevention and to protect
   > you and other customers from unauthorized use of payment
   > information. We retain this information for [X] and restrict access
   > to authorized personnel investigating suspected fraud.

4. **Data subject access/erasure requests** — there is currently no
   built-in "export/delete everything we hold about this person" tool
   covering `IpCapture` specifically; a DSAR response process needs to
   account for it (search by `signerEmail` via the `/ip-vault` page to
   locate the relevant rows).

## Key rotation (manual — no KMS/HSM is integrated)

`IP_ENCRYPTION_KEY`/`IP_HASH_KEY` are plain environment-variable secrets
(see `ip-encryption.ts`'s own "dev/demo-only key management" caveat —
same tier as `CARD_ENCRYPTION_KEY`/`GMAIL_TOKEN_ENCRYPTION_KEY`). There is
no automated rotation. To rotate manually:

1. Generate new keys: `openssl rand -base64 32` (twice — one for each
   variable).
2. **Rotating `IP_HASH_KEY` invalidates every existing `ipHash`/
   `subnetHash` value** — historical rows become unsearchable by exact
   IP/subnet match (their `encryptedIp` still decrypts fine under the
   unchanged `IP_ENCRYPTION_KEY`, so nothing is lost, just no longer
   indexed for search). Only rotate it if you're prepared to either
   accept that, or write a one-off backfill script that decrypts every
   existing row and recomputes its hash columns under the new key before
   the old key/value is discarded.
3. **Rotating `IP_ENCRYPTION_KEY`** makes every existing `encryptedIp`
   value undecryptable unless you re-encrypt it first. There is no
   built-in re-encryption tool; write a one-off script that reads every
   `IpCapture` row, decrypts under the old key, re-encrypts under the new
   one, in a single deployment window where both keys are available.
4. Never deploy a rotation where the app can read the new key but any
   already-running process instance is still writing under the old one —
   coordinate rotation with a full restart, not a rolling deploy that
   assumes forward-compatibility that doesn't exist here.
