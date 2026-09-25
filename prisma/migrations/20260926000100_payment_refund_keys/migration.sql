-- Additive: remembers which refund requests were already applied to a charge.
ALTER TABLE "PaymentCharge" ADD COLUMN "refundIdempotencyKeys" TEXT[] DEFAULT ARRAY[]::TEXT[];
