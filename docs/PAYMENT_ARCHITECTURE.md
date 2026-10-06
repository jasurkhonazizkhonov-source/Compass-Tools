# Payment architecture — how Compass Tools handles cards

Compass Tools keeps its **own** payment workflow. There is **no external payment
provider** of any kind (no Stripe, PayPal, Adyen, Braintree, Authorize.net,
Square, …): no SDK, no hosted fields, no webhooks, no provider keys. A customer
enters their card on the booking form, the CRM encrypts it into its own database,
and staff record payments by hand against the card on file. A repo-wide test
(`src/__tests__/stripe-removal.test.ts`) fails if a provider dependency, key,
webhook route or `src/server/payments` module reappears.

**Compass Tools is not PCI DSS certified and this is not PCI DSS-grade key
management.** The card vault is application-level AES-256-GCM encryption with a
single environment key. That is a deliberate, owner-accepted design for this
single-company CRM; it is not a compliance claim, and whoever operates a
deployment carries the responsibility of running it that way. This document
describes engineering boundaries only.

> **Do not remove this architecture again.** The customer card entry, the
> encrypted vault, contact-level payment methods, masked display, Admin-only
> Reveal, manual payment recording and payment history are core CRM features and
> are covered by regression tests. A change that deletes them is a regression.

## Hard rules (enforced by tests, not just by convention)

1. **The card security code (CVV / CVC / CVV2 / CVC2 / CID) is never stored in
   plaintext or in any ordinary record, cache, log, e-mail, audit entry, URL or
   browser storage — and "Reveal Card Information" never returns it.** Policy
   narrowed at the owner's explicit request (docs/CARD_VAULT_SECURITY.md section
   19): the booking form's CVV/CVC is format-checked, **encrypted immediately**
   and kept only in the dedicated `PaymentMethodCvv` table, for **at most 24 hours
   after the Booking Form was signed** (a fixed constant, not configurable, never
   extended), destroyed earlier when the payment is recorded as charged or
   cancelled or an Admin destroys it, and revealed only by a separate
   **Admin-only** action with its own rate limit, sign-in and booking-scope
   checks and audit trail. Guard tests pin exactly which source files may touch
   it, that the schema has no other column for it, that the database refuses a
   plaintext value or a longer window, and (real PostgreSQL) that a marker value
   is in **no** table in plaintext (`booking-submit.integration.test.ts`,
   `booking-cvv.integration.test.ts`). PIN, PIN blocks and magnetic-stripe/track
   data are never collected at all. This is not a claim of PCI DSS compliance.
2. **No card data in URLs, browser storage, logs, analytics, error messages,
   notifications or e-mail.** Staff e-mails and notifications carry brand +
   last4 + expiry only. Logs carry a safe error category, never a message that
   could embed a value. A free-text payment note that looks like a card number is
   rejected.
3. **The full card number leaves the database only through Reveal**, which
   requires an **explicit `payments.reveal` grant (Admin included)**, is
   IDOR-checked, per-account rate limited, requires a **sign-in within the last 15
   minutes** in production, and writes an audit entry. Every other query omits the
   ciphertext column (Prisma global `omit`).
4. **The vault fails closed.** `getPaymentVault()` opens only with a valid key ring
   and, in any production-class environment (production or a Vercel preview),
   only when the owner has set `CARD_VAULT_MODE` to the exact acceptance phrase.
   `APP_ENV=staging` (or any label) cannot open it — `APP_ENV` can only tighten.
   Until then a customer's "Finish Booking" is refused with "nothing was charged
   and no booking was recorded", and Admins see why in the readiness banner,
   System Health and `GET /api/health`. Full model, key management and rotation:
   **`docs/CARD_VAULT_SECURITY.md`**; enablement steps: `docs/DEPLOYMENT.md` §5c.
5. **No real charges are made by the application.** "Confirm payment" only
   *records* that staff took a payment through their own supplier/merchant
   process. Tests and fixtures use only the card networks' published test numbers
   (e.g. 4242 4242 4242 4242), never a real PAN.

## What exists

| Piece | Where |
|---|---|
| Customer card entry (cardholder, number, expiry, amount; split across several cards) | `src/components/booking/card-payment-section.tsx`, `booking-flow.tsx` |
| Atomic booking submit incl. card storage | `src/server/actions/booking.ts` (`submitBooking`) |
| Encrypted vault (versioned envelope, row-bound) | `src/server/security/payment-vault.ts`, `card-encryption.ts` (`PaymentMethod.encryptedPan`) |
| Key ring, rotation, retention purge | `card-keyring.ts`, `card-key-rotation.ts`, `card-retention.ts`, `npm run cards:rotate`, `npm run cards:purge` |
| Card audit events | `src/server/security/card-audit.ts` |
| Vault readiness (pure env check, no secrets) | `src/server/security/card-vault-status.ts` |
| Contact-level payment methods (add / edit / remove) | `src/server/actions/contact-payment-methods.ts` |
| Masked display + Admin Reveal | `src/components/bookings/payment-method-card.tsx`, `revealPaymentMethod` in `src/server/actions/payment-methods.ts` |
| Manual payment recording (success / failed, amount, currency, note, actor, timestamp), history | `confirmPaymentReceived` (status `SUCCEEDED` or `FAILED`) in `payment-methods.ts`, `charge-customer-panel.tsx` |
| Authorization | `src/server/security/permissions.ts` (`canRevealPaymentMethod`, `canConfirmPayment`, `canAccessPaymentMethod`) |

Data kept per payment method: cardholder name, brand, last4, expiry, encrypted
number, allocated amount, billing address, owner booking/contact, timestamps.
Per recorded payment (`PaymentCharge`): amount, currency, status
(`PENDING` / `SUCCEEDED` / `FAILED` / `CANCELED`), reference note, who recorded it
and when.

## Currency

The customer sees and pays in the quote's currency (e.g. AUD, `A$`); the amount
recorded on a payment uses that currency and is never silently converted to USD.
Internal profit, commission and sales-board figures stay in USD.

## Booking submission and Finish Booking

`submitBooking` validates the input, looks the quote up by its secure token,
replays an existing booking for the same signer (idempotent double click /
refresh / retry), refuses an already-booked or non-bookable quote, encrypts each
card and then, in **one database transaction**, claims the quote (→ `SIGNED`) and
creates the booking, passengers, signature (typed name, IP, user agent) and
payment methods, and moves the lead to `BOOKED`. IP-vault entry, activity log,
notification and staff e-mail run after the response and can never undo a booking.
If the vault is unavailable nothing is written and the customer is told so.

## Choosing to go further (a business decision — not made here)

If the business later wants to stop holding card numbers at all, that means
adopting an external tokenization service — a separate project that would
replace, not extend, this vault. The user has explicitly asked that no provider
be introduced; nothing here is built toward one.
