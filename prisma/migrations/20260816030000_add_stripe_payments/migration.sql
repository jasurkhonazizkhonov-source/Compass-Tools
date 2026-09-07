
-- CreateEnum
CREATE TYPE "PaymentChargeStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "stripeCustomerId" TEXT;

-- AlterTable
ALTER TABLE "PaymentReference" ADD COLUMN     "consentGivenAt" TIMESTAMP(3),
ADD COLUMN     "stripePaymentMethodId" TEXT,
ADD COLUMN     "stripeSetupIntentId" TEXT;

-- CreateTable
CREATE TABLE "PaymentCharge" (
    "id" TEXT NOT NULL,
    "paymentReferenceId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "PaymentChargeStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT,
    "errorMessage" TEXT,
    "initiatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCharge_stripePaymentIntentId_key" ON "PaymentCharge"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "PaymentCharge_paymentReferenceId_idx" ON "PaymentCharge"("paymentReferenceId");

-- CreateIndex
CREATE INDEX "PaymentCharge_status_idx" ON "PaymentCharge"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_stripeCustomerId_key" ON "Contact"("stripeCustomerId");

-- AddForeignKey
ALTER TABLE "PaymentCharge" ADD CONSTRAINT "PaymentCharge_paymentReferenceId_fkey" FOREIGN KEY ("paymentReferenceId") REFERENCES "PaymentReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentCharge" ADD CONSTRAINT "PaymentCharge_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

