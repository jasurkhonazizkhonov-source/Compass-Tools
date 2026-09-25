# Previous-Card Autofill — Security Scope

## What is implemented

A **masked selector that autofills the cardholder name only.**
`getPreviousPaymentMethodsForContact` (`src/server/queries/bookings.ts`) returns,
per previously-used card, the cardholder name, last four digits, brand and
expiry — for display in the dropdown. Choosing one fills **only the cardholder
name** on the new card form. The customer always enters the card itself in the
payment provider's secure fields.

## Why the card itself is never autofilled

Compass Tools holds **no card number and no security code**: the payment provider
vaults the card (see `docs/PAYMENT_ARCHITECTURE.md`), and this app keeps only an
opaque provider reference plus brand/last4/expiry. So there is nothing here to
autofill a card *with*, and a card number could not be retrieved from the CRM
even by an Admin.

Reusing a previously vaulted card on a **new** booking (skipping re-entry) is a
possible future feature, and would work by referencing the provider's saved
payment method — never by re-exposing card data. It would need its own review of
consent and the provider's rules for reuse; it is not built.

## What this feature does NOT do

- Never returns, logs, or transmits a card number or security code — this app
  has neither.
- Never sends card data to customer emails, internal notifications, or analytics.
- Only returns cards belonging to the requesting customer's own contact record,
  scoped server-side the same way passenger/billing history is (the query is
  keyed on the quote's `contactId`, never on a client-supplied id).
