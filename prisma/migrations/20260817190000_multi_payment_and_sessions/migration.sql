-- CreateEnum
CREATE TYPE "PaymentWorkflowStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'FAILED', 'CONFIRMED', 'CANCELLED');

-- DropIndex (PaymentMethod moves from one-to-one to one-to-many with Booking)
DROP INDEX "PaymentMethod_bookingId_key";

-- AlterTable: session fields on Account
ALTER TABLE "Account" ADD COLUMN     "activeSessionId" TEXT,
ADD COLUMN     "sessionCreatedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Account_activeSessionId_key" ON "Account"("activeSessionId");

-- AlterTable: PaymentMethod gains amountAllocated + workflowStatus.
-- amountAllocated is added nullable first, backfilled from the booking's
-- totalAmount (every existing row today is a single, fully-allocated card
-- from before multi-card support existed), then tightened to NOT NULL.
ALTER TABLE "PaymentMethod" ADD COLUMN     "amountAllocated" DECIMAL(10,2),
ADD COLUMN     "workflowStatus" "PaymentWorkflowStatus" NOT NULL DEFAULT 'PENDING';

UPDATE "PaymentMethod" pm
SET "amountAllocated" = b."totalAmount"
FROM "Booking" b
WHERE pm."bookingId" = b."id" AND pm."amountAllocated" IS NULL;

ALTER TABLE "PaymentMethod" ALTER COLUMN "amountAllocated" SET NOT NULL;
