# Payment architecture — provider-vaulted cards and manual charges

**Compass Tools is not a payment-card database and is not PCI DSS certified.**
Card capture and storage are delegated to a PCI-compliant payment provider
(Stripe, through the adapter boundary in `src/server/payments/`). This document
states what the code does, what it deliberately refuses to do, and what must be
configured. It describes engineering boundaries, not a compliance claim.

## The business requirement, and how it is met

Business Flights Travel must be able to charge a customer's card **later**
(manually, by an authorized Admin) after the customer completes a booking.

```
Customer types card details into the PROVIDER's hosted fields (iframes)
   → provider vaults a reusable payment method
   → Compass Tools receives only an opaque reference (SetupIntent id)
   → submitBooking re-verifies that reference with the provider (server-side)
   → booking commits atomically with the payment-method REFERENCE
   → Admin later chooses "Manual charge" on the booking
   → Compass Tools tells the provider to charge the vaulted method (off-session)
   → provider processes it; result stored; signed webhooks keep it in sync
```

Because the provider holds the reusable credential, a later charge needs
**neither the card number nor a stored security code**. That is what makes the
requirement achievable without storing a CVV.

## Hard rules (enforced by tests, not just convention)

1. **The card security code (CVV/CVC/CVV2/CVC2/CID), PIN and track data are never
   collected by, sent to, cached in, stored by, logged by, e-mailed by, or
   exported from Compass Tools.** The customer types the security code into the
   provider's own iframe; it goes from their browser straight to the provider.
   There is no field, key, column, cache or table for one. A request to add a
   "temporary encrypted CVV vault", a 24-hour CVV cache or table, or a
   scheduled-deletion workaround is refused: PCI DSS forbids retaining a
   security code after authorization (including for card-on-file use), and
   encryption or a short lifetime does not change that. If a particular
   transaction genuinely needs a fresh security code, it must be collected again
   through the provider's compliant interface — never retrieved from us.
   - `stripe-removal.test.ts` fails if any executable source line mentions a
     security code (one allow-listed defensive deny-list aside), and
     `booking-submit.integration.test.ts` scans **every column of every table**
     to prove a submitted marker value is nowhere.
2. **Compass Tools holds no card number.** Full-number storage, the development
   AES vault and the "Reveal" workflow were removed; no server code reads or
   writes `PaymentMethod.encryptedPan` (a legacy nullable column left in place —
   production never held a value in it).
3. **No payment data in URLs, browser storage, logs, analytics, error messages,
   notifications or e-mail.** Logs carry a safe error category, never payloads.
   Audit rows carry last4 only. Webhook events store id/type/outcome, never the
   payload. Provider free-text errors are never shown or stored.
4. **Provider secrets never reach a browser.** Only the publishable key is sent
   to a page (by design of the provider); the secret key and webhook secret are
   read server-side only, and a repo test confines those variable names to
   `src/server/payments/`.
5. **No real charges in tests.** Tests use an in-memory fake provider; live
   verification uses the provider's test mode and its official test cards.
6. **`APP_ENV` cannot switch any of this off.** Booking availability depends
   only on a valid provider configuration.

## What Compass Tools stores, and what it cannot do

| | |
|---|---|
| **Compass Tools stores** | provider name, provider customer id, provider payment-method id, the capture (SetupIntent) id, card brand, last4, expiry month/year, funding type, cardholder name, amount allocated, vault status, workflow status; per charge: amount, currency, status, provider PaymentIntent id, idempotency key, failure category/code (short vocabulary), refunded amount, who initiated it, timestamps. |
| **The provider stores** | the card number and all card credentials. |
| **Admins can see** | `Visa •••• 4242 · Expires 08/2029 · Cardholder`, allocation, vault status, charge history. |
| **Nobody can retrieve from Compass Tools** | the full card number, the security code. There is no action, query or column that could return them. |

## Manual charge workflow (Admin only)

`initiateManualCharge` (`src/server/actions/manual-charge.ts` → `src/server/payments/manual-charge.ts`):

- **Authorization:** Admin only (`canInitiateManualCharge`), re-checked on the
  server; hidden buttons are not the control. The booking must be visible to the
  actor and the payment method must belong to **that** booking (IDOR-safe).
- **Exactly-once:** the dialog generates an idempotency key (unique column on
  `PaymentCharge`), and the provider call reuses it. A double click, replay, or
  retry after a timeout cannot charge twice; a key reused for a different
  amount is refused; only one charge may be in flight per card.
- **Never trusts the browser:** the request carries no status, currency, or
  provider ids — those come from our own rows and the provider's response.
- **Currency:** always the booking's own currency (e.g. AUD), never converted.
- **Limits:** the existing charge ceiling (allocation × 5 + 5000), applied
  cumulatively; expired, removed, detached, or legacy (never-vaulted) cards are
  refused.
- **Outcome unknown** (provider timeout): the charge stays `PENDING`, a
  health incident is raised, and "Retry" re-asks the provider with the same key.
- **Statuses:** `PENDING` → `SUCCEEDED` / `FAILED` / `CANCELED`; refunds move a
  success to `PARTIALLY_REFUNDED` / `REFUNDED`. Status transitions are
  forward-only and shared by the synchronous path and the webhooks
  (`src/server/payments/charge-state.ts`). A saved payment method is **not** a
  payment; booking/quote status rules (Ticketed→Booked, Confirmed→Charged, …)
  are untouched.
- **Audit:** `MANUAL_CHARGE_REQUESTED/SUCCEEDED/FAILED/PROCESSING`,
  `PAYMENT_REFUNDED` with actor, booking, amount, currency, PaymentIntent id
  and last4 only.

Refunds (`refundManualCharge`) are Admin-only, idempotent per client key, and
capped at what remains of the charge.

## Webhook: `POST /api/webhooks/payments`

Authenticated **only** by the provider's signature over the raw body (HMAC
verified in constant time, 5-minute replay window). Idempotent through
`PaymentWebhookEvent`; out-of-order safe; unknown events acknowledged;
handled: `payment_intent.succeeded/processing/payment_failed/canceled`,
`charge.refunded`, `payment_method.detached`. Rejections raise a sanitized
System Health incident carrying only the reason.

## Configuration (Vercel → Settings → Environment Variables)

| Variable | Purpose |
|---|---|
| `PAYMENT_PROVIDER` | `stripe` (selects the adapter). |
| `STRIPE_SECRET_KEY` | Server-side API key (`sk_test_…` / `sk_live_…`, or a restricted `rk_…`). |
| `STRIPE_PUBLISHABLE_KEY` | Public key for the hosted fields (`pk_test_…` / `pk_live_…`). Must be the same mode as the secret key. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint (`whsec_…`). |

Webhook endpoint to create in the provider dashboard:
`https://<your-domain>/api/webhooks/payments`, events `payment_intent.succeeded`,
`payment_intent.processing`, `payment_intent.payment_failed`,
`payment_intent.canceled`, `charge.refunded`, `payment_method.detached`.

**Test and live cannot be confused:** the secret and publishable keys must agree
(a mismatch is reported *Invalid* and keeps bookings unavailable); System Health
shows **Warning** when test keys run on a production deployment (real cards will
be declined). Use test keys + the provider's official test cards for
verification; switch to live keys only when you intend to take real payments.

## System Health and readiness

`/system-health` (Admin only) reports, without revealing any value:
provider selected; credentials Configured / Missing / Invalid; the provider API
probe (Healthy / Invalid credentials / Unreachable); card vaulting and manual
(off-session) charging availability; test-vs-live mode; webhook secret; stuck or
failing charges; plus incidents for provider errors, rejected webhooks and
failed bookings. `/api/health` exposes only `bookingPayment: available|unavailable`
and `paymentProvider: ready|not_configured|invalid` (configuration only, no
network probe). The banner "Customers cannot complete bookings right now" shows
exactly while the provider is not usable, and disappears only when its
configuration is valid.

## Resilience of the booking flow

- Browser → provider capture, then a server action re-verifies the capture with
  the provider (status, quote binding, customer binding, card validity,
  not-already-used). A forged, incomplete, expired or foreign capture is refused.
- The booking, passengers, signature (with IP), payment-method **reference**,
  quote → SIGNED and lead → BOOKED commit in one database transaction. If it
  fails, nothing is left behind.
- A capture that succeeded but whose booking did not commit leaves only an
  unused, uncharged vaulted method at the provider (no money moved, no booking
  row). A retry reuses the same capture (idempotent setup keyed by quote+slot),
  so the customer is not asked to re-enter the card; a duplicate submission
  replays the original booking.
- Provider timeouts are reported as "try again — nothing was charged"; provider
  outages raise a System Health incident.

## Data-model summary

`PaymentMethod` (+ `provider`, `providerCustomerId`, `providerPaymentMethodId`,
`providerSetupIntentId` (unique), `cardFunding`, `vaultStatus`), `PaymentCharge`
(+ `provider`, `providerPaymentIntentId` (unique), `idempotencyKey` (unique),
`failureCategory/Code`, `refundedAmount`, `refundIdempotencyKeys`), `Contact.providerCustomerId`
(unique), `PaymentWebhookEvent`. All additive migrations; `encryptedPan` became
nullable. The unused `CvvRecollectionRequest` table is left untouched (no code
reads or writes it).
