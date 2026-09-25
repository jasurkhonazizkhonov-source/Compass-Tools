# Payment architecture — what Compass Tools does and does not do with cards

**Compass Tools is not a payment-card database, and it is not PCI DSS certified.**
This document states what the code actually does today, what it deliberately
refuses to do, and what a real production integration requires. Nothing here is
a compliance claim; it describes engineering boundaries.

## Hard rules (enforced by tests, not just by convention)

1. **The card security code (CVV / CVC / CVV2 / CVC2 / CID), PIN, PIN block and
   magnetic-stripe/track data are never collected, received, cached, stored,
   logged, e-mailed or sent to analytics by Compass Tools.** There is no field
   for one in the customer form, no key for one in the booking action's input
   schema, no column for one in any table, and no in-memory cache. A client that
   still sends one has it dropped at the schema boundary; a real-PostgreSQL test
   scans **every column of every table** to prove a submitted marker value is
   nowhere (`booking-submit.integration.test.ts`, "NO CVV ANYWHERE"). A
   repo-wide test (`stripe-removal.test.ts`) fails if any executable source
   line mentions a security code.
   - There is **no** "temporary encrypted CVV vault", **no** 24-hour CVV table
     or cache, **no** scheduled-deletion workaround, and customer consent does
     not change this. The earlier in-memory CVV cache, the "Start Supplier
     Payment" authorization, and the emailed "CVV recollection" link were
     removed.
   - If a supplier requires a security code for a manual charge, that must go
     through a PCI-compliant provider workflow (a provider-hosted payment link
     / virtual terminal), never through this application.
2. **No payment data in URLs, browser storage, logs, analytics, error messages,
   notifications or e-mail.** Booking-signed staff e-mails carry brand + last4 +
   expiry only. Logs carry a safe error category, never a message that could
   embed a value.
3. **The production card vault is fail-closed.** `getPaymentVault()` refuses to
   store or reveal any card in production. `APP_ENV` cannot relabel a real
   Vercel production deployment (`VERCEL_ENV=production` is always production),
   so setting `APP_ENV=staging` is **not** a way around this and must not be
   used as one.
4. **No real charges in development or tests.** Use a provider's sandbox and its
   official test card numbers only. Never put a real PAN or security code in
   source, tests, fixtures, screenshots, docs or logs.

## What exists today

| Piece | State |
|---|---|
| Customer booking form | Collects cardholder name, card number, expiry, amount. **No security code.** Development only in practice (see next row). |
| Card storage | `PaymentVault` interface (`src/server/security/payment-vault.ts`). Non-production: a development AES-256-GCM wrapper, **test card numbers only**. Production: `ProductionVaultNotConfigured` — every store/reveal throws. |
| Production bookings | **Blocked on purpose.** A customer's "Finish Booking" is refused with "nothing was charged and no booking was recorded" until a real provider is integrated. |
| Provider boundary | `src/server/payments/provider.ts` defines the adapter contract (tokens and non-sensitive metadata only) and reports readiness honestly. **No adapter is installed**; `getPaymentProviderStatus()` is `not_configured` no matter what environment variables say. |
| Admin visibility | System Health → "Payment provider & booking readiness" is **Critical** in production until a provider is integrated. `/api/health` reports `readiness.paymentProvider` (`ready` / `not_configured`) and `readiness.bookingCardStorage`. |

## What the CRM may retain once a provider is integrated

Only non-sensitive metadata: processor, customer / payment-method token ids,
transaction and authorization ids, brand, last4, expiry, cardholder name (if the
provider requires it), result, amount, currency, status, timestamps and a
failure category. The Admin UI shows `Visa •••• 4242 — Expires 08/2029`, never a
full card number. (The existing "Reveal" of a full number works only against the
non-production development vault.)

## Choosing a provider (a business decision — not made here)

Criteria: PCI-compliant hosted fields or redirect so the raw number never
touches Compass Tools servers (SAQ A scope); tokenization with a stable
payment-method token; manual / phone-order ("MOTO") capture **hosted by the
provider** for cases where the customer is not on the site; sandbox with
official test cards; idempotency keys; webhooks with signature verification;
support for the currencies this CRM quotes in (USD and the supported list in
`src/lib/currency.ts`).

## Steps to integrate a provider

1. Pick the provider and obtain **sandbox** credentials only.
2. Implement `PaymentProviderAdapter` (`provider.ts`) in a new module and
   register it in the `ADAPTERS` map. Declare its required environment
   variables in `requiredEnv` (names only). `getPaymentProviderStatus()` then
   reports `ready` only when the adapter exists **and** every variable is set.
3. Replace the customer form's card inputs with the provider's hosted fields
   (`createClientSession` → provider fields → `confirmTokenizedMethod`).
4. Schema (additive migration): make `PaymentMethod.encryptedPan` nullable and
   add `provider`, `providerCustomerId`, `providerPaymentMethodId`. Stop writing
   `encryptedPan` when a provider is configured. Do not drop existing data.
5. Route "record a charge" through `adapter.charge(...)` with an idempotency key;
   keep `PaymentCharge` for the result, amount, currency and failure category.
6. Verify webhooks with the provider's signature scheme; never trust a
   client-supplied result.
7. Test only with the provider's sandbox and official test cards; confirm the
   repo-wide guard tests still pass; then follow the launch checklist in
   `docs/DEPLOYMENT.md` §5c.

Until step 2–3 are done, production bookings stay off and System Health says so.
