# Previous-Card Autofill — Security Scope (Pass 25)

## What was requested

Let a customer filling out a booking form select a previously-used card
from an earlier booking and have the payment section autofill from it.

## What is actually implemented

A **masked selector only**. `getPreviousPaymentMethodsForContact`
(`src/server/queries/bookings.ts`) returns, per previously-used card:
cardholder name, last 4 digits, card brand, expiry month/year. Selecting
one autofills **only those fields** into the new card form. The customer
must always manually re-type the full card number — it is
never returned by this query, offered in the UI, or autofilled.

## Why the full card number is not autofilled

This app's card storage (`src/server/security/payment-vault.ts`) is
application-level AES-256-GCM encryption — **not** PCI DSS-grade key
management (see `docs/PAYMENT_ARCHITECTURE.md`). Decrypting a stored PAN
is reserved for the audited, Admin-only Reveal action. Re-exposing a
previously-stored PAN into a brand-new, unrelated transaction — pulling
decrypted card data back out of storage for a convenience feature rather
than the original authorized charge it was collected for — is exactly the
kind of unnecessary cardholder-data re-exposure that scope-reduction
principles exist to prevent, so full-PAN autofill is deliberately not
offered. The customer re-types the number; only the masked details
(cardholder, brand, last 4, expiry) are offered.

## What this feature does NOT do

- Never returns, logs, or transmits a full card number for this purpose.
- Never returns, stores, or offers a CVV for autofill. **Compass Tools never
  collects or stores a CVV at all** — see `docs/PAYMENT_ARCHITECTURE.md`.
- Never sends card data to customer emails, internal notifications, or
  analytics.
- Only returns cards belonging to the requesting customer's own
  contact record, scoped server-side the same way passenger/billing
  autofill is (never a client-supplied identifier trusted on its own).
