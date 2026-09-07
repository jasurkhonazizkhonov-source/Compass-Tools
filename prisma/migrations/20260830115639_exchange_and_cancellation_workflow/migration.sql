-- Exchange & Cancellation workflow — additive only.
--
-- NOTE: this database also contains NewsletterSubscriber, SheetSyncRecord,
-- SubmissionSequence tables (and SheetSyncStatus/SubmissionKind enums) that
-- are NOT part of this project's Prisma schema or migration history — an
-- external system writes to this same shared database outside this app's
-- own tracking. A plain `prisma migrate dev`/`db push` run against this
-- database will therefore report those as "drift" and offer to DROP them —
-- do NOT accept that. This migration was applied by hand (see the
-- accompanying commit/PR description) with exactly the statements below,
-- deliberately excluding any DROP TABLE/DROP TYPE for those external
-- objects, then marked applied via `prisma migrate resolve --applied
-- 20260830115639_exchange_and_cancellation_workflow` so migration history
-- stays consistent without touching them.

-- CreateEnum
CREATE TYPE "CancellationRequestStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISREGARDED');

-- AlterEnum
ALTER TYPE "QuoteStatus" ADD VALUE 'EXCHANGED';
ALTER TYPE "QuoteStatus" ADD VALUE 'PENDING_EXCHANGE_APPROVAL';
ALTER TYPE "QuoteStatus" ADD VALUE 'EXCHANGE_APPROVED';
ALTER TYPE "QuoteStatus" ADD VALUE 'EXCHANGE_DISAPPROVED';
ALTER TYPE "QuoteStatus" ADD VALUE 'PENDING_CANCELLATION_APPROVAL';
ALTER TYPE "QuoteStatus" ADD VALUE 'CANCELLATION_CONFIRMED';

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "exchangeFee" DECIMAL(10,2),
ADD COLUMN     "fareDifference" DECIMAL(10,2),
ADD COLUMN     "originalQuoteId" TEXT,
ADD COLUMN     "pnr" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- CreateTable
CREATE TABLE "QuoteCancellationRequest" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "segmentIds" TEXT[],
    "cancellationFee" DECIMAL(10,2),
    "internalNotes" TEXT,
    "pnr" TEXT,
    "status" "CancellationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "QuoteCancellationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteCancellationRequest_quoteId_idx" ON "QuoteCancellationRequest"("quoteId");

-- CreateIndex
CREATE INDEX "QuoteCancellationRequest_status_idx" ON "QuoteCancellationRequest"("status");

-- CreateIndex
CREATE INDEX "QuoteCancellationRequest_createdById_idx" ON "QuoteCancellationRequest"("createdById");

-- CreateIndex
CREATE INDEX "QuoteCancellationRequest_reviewedById_idx" ON "QuoteCancellationRequest"("reviewedById");

-- CreateIndex
CREATE INDEX "Quote_originalQuoteId_idx" ON "Quote"("originalQuoteId");

-- CreateIndex
CREATE INDEX "Quote_reviewedById_idx" ON "Quote"("reviewedById");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_originalQuoteId_fkey" FOREIGN KEY ("originalQuoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteCancellationRequest" ADD CONSTRAINT "QuoteCancellationRequest_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteCancellationRequest" ADD CONSTRAINT "QuoteCancellationRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteCancellationRequest" ADD CONSTRAINT "QuoteCancellationRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
