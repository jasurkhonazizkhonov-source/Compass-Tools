-- Additive only. Adds the provider-vault references (no card data, no security
-- code), the charge fields a provider-processed manual charge needs, a webhook
-- idempotency ledger, and a provider customer id on Contact. The only change to
-- an existing column is DROP NOT NULL on PaymentMethod.encryptedPan (new,
-- provider-vaulted methods have no card number to store); no data is touched.

-- CreateEnum
CREATE TYPE "PaymentVaultStatus" AS ENUM ('NOT_VAULTED', 'VAULTED', 'DETACHED');

-- AlterEnum
ALTER TYPE "PaymentChargeStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';
ALTER TYPE "PaymentChargeStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_REFUNDED';

-- AlterTable
ALTER TABLE "PaymentMethod" ALTER COLUMN "encryptedPan" DROP NOT NULL;
ALTER TABLE "PaymentMethod" ADD COLUMN "provider" TEXT,
ADD COLUMN "providerCustomerId" TEXT,
ADD COLUMN "providerPaymentMethodId" TEXT,
ADD COLUMN "providerSetupIntentId" TEXT,
ADD COLUMN "cardFunding" TEXT,
ADD COLUMN "vaultStatus" "PaymentVaultStatus" NOT NULL DEFAULT 'NOT_VAULTED';

-- AlterTable
ALTER TABLE "PaymentCharge" ADD COLUMN "provider" TEXT,
ADD COLUMN "providerPaymentIntentId" TEXT,
ADD COLUMN "idempotencyKey" TEXT,
ADD COLUMN "failureCategory" TEXT,
ADD COLUMN "failureCode" TEXT,
ADD COLUMN "refundedAmount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "providerCustomerId" TEXT;

-- CreateTable
CREATE TABLE "PaymentWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "PaymentWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_providerSetupIntentId_key" ON "PaymentMethod"("providerSetupIntentId");
CREATE INDEX "PaymentMethod_providerPaymentMethodId_idx" ON "PaymentMethod"("providerPaymentMethodId");
CREATE UNIQUE INDEX "PaymentCharge_providerPaymentIntentId_key" ON "PaymentCharge"("providerPaymentIntentId");
CREATE UNIQUE INDEX "PaymentCharge_idempotencyKey_key" ON "PaymentCharge"("idempotencyKey");
CREATE UNIQUE INDEX "Contact_providerCustomerId_key" ON "Contact"("providerCustomerId");
CREATE INDEX "PaymentWebhookEvent_receivedAt_idx" ON "PaymentWebhookEvent"("receivedAt");
