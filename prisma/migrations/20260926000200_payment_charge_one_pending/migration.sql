-- Additive: last-resort database guarantee that a payment method has at most ONE
-- provider charge in flight at a time (the application also serializes this with
-- an advisory lock). A partial unique index; Prisma's schema language cannot
-- express it, so it lives only in this migration.
CREATE UNIQUE INDEX "PaymentCharge_one_pending_per_method" ON "PaymentCharge"("paymentMethodId") WHERE "status" = 'PENDING' AND "provider" IS NOT NULL;
