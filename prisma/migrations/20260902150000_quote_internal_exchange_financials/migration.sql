-- Pass 13 §22/§23/§24 — internal-only exchange financial fields, separate
-- from the existing customer-facing Quote.exchangeFee/fareDifference.
-- Additive only, both nullable, no default data migration needed (every
-- existing exchange quote simply has these as NULL, meaning "not entered
-- yet" — the same state the customer-facing fields already start in).
ALTER TABLE "Quote" ADD COLUMN "internalExchangeFee" DECIMAL(10,2);
ALTER TABLE "Quote" ADD COLUMN "internalFareDifference" DECIMAL(10,2);
