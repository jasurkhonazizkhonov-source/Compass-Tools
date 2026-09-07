-- Removes Stripe entirely and replaces PaymentReference/PaymentCharge with
-- a CRM-native PaymentMethod model. Existing PaymentReference/PaymentCharge
-- rows were all created against Stripe TEST-mode data during development —
-- not real customer cards — and cannot be meaningfully migrated forward
-- (the old architecture never stored a raw PAN to encrypt; that was the
-- entire point of Stripe tokenization), so they are deleted here rather
-- than left as orphaned/invalid rows.

-- Clear existing test-only payment rows before restructuring.
DELETE FROM "PaymentCharge";
DELETE FROM "PaymentReference";

-- CreateEnum
CREATE TYPE "PaymentMethodStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- DropForeignKey
ALTER TABLE "PaymentCharge" DROP CONSTRAINT "PaymentCharge_paymentReferenceId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentReference" DROP CONSTRAINT "PaymentReference_bookingId_fkey";

-- DropIndex
DROP INDEX "Contact_stripeCustomerId_key";

-- DropIndex
DROP INDEX "PaymentCharge_paymentReferenceId_idx";

-- DropIndex
DROP INDEX "PaymentCharge_stripePaymentIntentId_key";

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "paymentPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Contact" DROP COLUMN "stripeCustomerId";

-- AlterTable
ALTER TABLE "PaymentCharge" DROP COLUMN "description",
DROP COLUMN "paymentReferenceId",
DROP COLUMN "stripePaymentIntentId",
ADD COLUMN     "paymentMethodId" TEXT NOT NULL,
ADD COLUMN     "referenceNote" TEXT;

-- DropTable
DROP TABLE "PaymentReference";

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "cardholderName" TEXT NOT NULL,
    "encryptedPan" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "cardBrand" TEXT,
    "expiryMonth" INTEGER NOT NULL,
    "expiryYear" INTEGER NOT NULL,
    "status" "PaymentMethodStatus" NOT NULL DEFAULT 'ACTIVE',
    "consentGivenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_bookingId_key" ON "PaymentMethod"("bookingId");

-- CreateIndex
CREATE INDEX "PaymentMethod_bookingId_idx" ON "PaymentMethod"("bookingId");

-- CreateIndex
CREATE INDEX "PaymentCharge_paymentMethodId_idx" ON "PaymentCharge"("paymentMethodId");

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentCharge" ADD CONSTRAINT "PaymentCharge_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
