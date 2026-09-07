-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "quoteId" TEXT;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill existing rows using their most recent known status timestamp
-- (rather than leaving them all at "now", which would make the initial
-- activity-sort order meaningless for pre-existing data).
UPDATE "Quote" SET "lastActivityAt" = GREATEST(
  "createdAt",
  COALESCE("sentAt", "createdAt"),
  COALESCE("readAt", "createdAt"),
  COALESCE("viewedAt", "createdAt"),
  COALESCE("signedAt", "createdAt"),
  COALESCE("bookedAt", "createdAt"),
  COALESCE("canceledAt", "createdAt")
);

-- CreateIndex
CREATE INDEX "Notification_quoteId_idx" ON "Notification"("quoteId");

-- CreateIndex
CREATE INDEX "Quote_lastActivityAt_idx" ON "Quote"("lastActivityAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
