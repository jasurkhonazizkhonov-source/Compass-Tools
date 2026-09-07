# Previous-Card Autofill — Security Scope (Pass 25)

## What was requested

Let a customer filling out a booking form select a previously-used card
from an earlier booking and have the payment section autofill from it.

## What is actually implemented

A **masked selector only**. `getPreviousPaymentMethodsForContact`
(`src/server/queries/bookings.ts`) returns, per previously-used card:
cardholder name, last 4 digits, card brand, expiry month/year. Selecting
one autofills **only those fields** into the new card form. The customer
must always manually re-type the full card number and CVV — neither is
ever returned by this query, offered in the UI, or autofilled.

## Why the full card number is not autofilled

This app's card storage (`src/server/security/payment-vault.ts`) is
explicit about its own scope, in its own header comment: the only
implementation today is a **dev-only** AES-256-GCM wrapper, and the
production code path (`ProductionVaultNotConfigured`) **refuses to
reveal** any stored card at all — it throws rather than proceeding with
non-PCI-compliant storage. Two separate reasons this pass did not build
full-PAN autofill on top of that:

1. **It would not work in production at all.** Any real deployment of
   this app has `reveal()` throwing unconditionally. A feature built on
   top of it would only ever function in dev, silently break the moment
   a real vault provider is wired up, and give a false impression that
   autofill works.
2. **It would be the wrong thing to build even in dev.** Re-exposing a
   previously-stored PAN into a brand-new, unrelated transaction is
   exactly the kind of unnecessary cardholder-data re-exposure PCI
   scope-reduction principles exist to prevent — pulling decrypted card
   data back out of storage for a convenience feature, not the original
   authorized charge it was collected for.

## What would be required to safely support full-card autofill

A real, PCI-compliant tokenization provider (Stripe, Braintree, a
KMS/HSM-backed vault, etc.) sitting behind the existing `PaymentVault`
interface, where "autofill" means the provider's own hosted
field/tokenization flow re-presents a saved payment method without this
application ever handling the raw PAN at all (the standard SAQ-A-scoped
pattern most payment providers support natively). That is an
infrastructure/vendor decision outside this pass's scope — the
`PaymentVault` interface (`payment-vault.ts`) is already the intended
seam for it; no code in this pass narrows or works around that seam.

## What this feature does NOT do

- Never returns, logs, or transmits a full card number for this purpose.
- Never returns, stores, or offers a CVV for autofill (CVV is never
  persisted anywhere in this app outside a short-lived in-memory cache
  tied to the original charge — see `cvv-cache.ts`).
- Never sends card data to customer emails, internal notifications, or
  analytics.
- Only returns cards belonging to the requesting customer's own
  contact record, scoped server-side the same way passenger/billing
  autofill is (never a client-supplied identifier trusted on its own).
