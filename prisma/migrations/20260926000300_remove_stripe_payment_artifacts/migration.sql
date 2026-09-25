-- Removes the artifacts added by the (reverted) provider/Stripe payment work
-- (migrations 20260926000000..000200) and restores PaymentMethod.encryptedPan to
-- NOT NULL, returning the payment schema to the CRM's own card-vault design.
--
-- SAFETY: every step is CONDITIONAL and non-destructive of data. A table or
-- column is dropped only if it is provably unused (empty / all NULL); if any row
-- carries provider data, that artifact is LEFT IN PLACE (the application no
-- longer reads or writes it) and the migration still succeeds. Nothing that
-- holds customer, booking or payment-method data from before is touched, and no
-- table is dropped unless it is empty.
--
-- (The PaymentChargeStatus enum values REFUNDED / PARTIALLY_REFUNDED cannot be
-- removed from a PostgreSQL enum; they stay, unused.)

DO $$
BEGIN
  -- Webhook ledger: empty on any deployment where no provider was ever configured.
  IF to_regclass('"PaymentWebhookEvent"') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "PaymentWebhookEvent") THEN
      DROP TABLE "PaymentWebhookEvent";
    END IF;
  END IF;

  -- PaymentCharge provider columns (+ their indexes go with them).
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PaymentCharge' AND column_name = 'provider') THEN
    IF NOT EXISTS (
      SELECT 1 FROM "PaymentCharge"
      WHERE "provider" IS NOT NULL OR "providerPaymentIntentId" IS NOT NULL OR "idempotencyKey" IS NOT NULL
         OR "failureCategory" IS NOT NULL OR "failureCode" IS NOT NULL OR "refundedAmount" <> 0
         OR cardinality("refundIdempotencyKeys") > 0
    ) THEN
      DROP INDEX IF EXISTS "PaymentCharge_one_pending_per_method";
      ALTER TABLE "PaymentCharge"
        DROP COLUMN IF EXISTS "provider",
        DROP COLUMN IF EXISTS "providerPaymentIntentId",
        DROP COLUMN IF EXISTS "idempotencyKey",
        DROP COLUMN IF EXISTS "failureCategory",
        DROP COLUMN IF EXISTS "failureCode",
        DROP COLUMN IF EXISTS "refundedAmount",
        DROP COLUMN IF EXISTS "refundIdempotencyKeys";
    END IF;
  END IF;

  -- PaymentMethod provider columns.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PaymentMethod' AND column_name = 'provider') THEN
    IF NOT EXISTS (
      SELECT 1 FROM "PaymentMethod"
      WHERE "provider" IS NOT NULL OR "providerCustomerId" IS NOT NULL OR "providerPaymentMethodId" IS NOT NULL
         OR "providerSetupIntentId" IS NOT NULL OR "cardFunding" IS NOT NULL OR "vaultStatus" <> 'NOT_VAULTED'
    ) THEN
      DROP INDEX IF EXISTS "PaymentMethod_providerPaymentMethodId_idx";
      ALTER TABLE "PaymentMethod"
        DROP COLUMN IF EXISTS "provider",
        DROP COLUMN IF EXISTS "providerCustomerId",
        DROP COLUMN IF EXISTS "providerPaymentMethodId",
        DROP COLUMN IF EXISTS "providerSetupIntentId",
        DROP COLUMN IF EXISTS "cardFunding",
        DROP COLUMN IF EXISTS "vaultStatus";
    END IF;
  END IF;

  -- The vault-status enum, once nothing uses it.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE udt_name = 'PaymentVaultStatus')
     AND EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentVaultStatus') THEN
    DROP TYPE "PaymentVaultStatus";
  END IF;

  -- Contact.providerCustomerId
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Contact' AND column_name = 'providerCustomerId') THEN
    IF NOT EXISTS (SELECT 1 FROM "Contact" WHERE "providerCustomerId" IS NOT NULL) THEN
      ALTER TABLE "Contact" DROP COLUMN "providerCustomerId";
    END IF;
  END IF;

  -- Restore the original NOT NULL only when no row would violate it.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'PaymentMethod' AND column_name = 'encryptedPan' AND is_nullable = 'YES') THEN
    IF NOT EXISTS (SELECT 1 FROM "PaymentMethod" WHERE "encryptedPan" IS NULL) THEN
      ALTER TABLE "PaymentMethod" ALTER COLUMN "encryptedPan" SET NOT NULL;
    END IF;
  END IF;
END
$$;
