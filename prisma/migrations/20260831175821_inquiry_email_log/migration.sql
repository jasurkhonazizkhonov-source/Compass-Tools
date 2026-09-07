-- Additive only.
--
-- NOTE (see 20260830115639_exchange_and_cancellation_workflow's own note):
-- this database also contains NewsletterSubscriber, SheetSyncRecord,
-- SubmissionSequence tables (and SheetSyncStatus/SubmissionKind enums) that
-- are NOT part of this project's Prisma schema or migration history — an
-- external system writes to this same shared database outside this app's
-- own tracking. A plain `prisma migrate dev`/`db push` run against this
-- database will therefore report those as "drift" and offer to DROP them —
-- do NOT accept that. This migration was applied by hand with exactly the
-- statements below, deliberately excluding any DROP TABLE/DROP TYPE for
-- those external objects, then marked applied via `prisma migrate resolve
-- --applied 20260831175821_inquiry_email_log` so migration history stays
-- consistent without touching them.
--
-- Item 9 — a new EmailType value plus a nullable EmailLog.contactInquiryId
-- FK, so an email sent from the new Get in Touch internal composer is
-- actually traceable back to the inquiry it was sent from, mirroring
-- EmailLog's existing leadId/quoteId/bookingId/contactId traceability
-- convention exactly.

-- AlterEnum
ALTER TYPE "EmailType" ADD VALUE 'INQUIRY_EMAIL';

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN "contactInquiryId" TEXT;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_contactInquiryId_fkey" FOREIGN KEY ("contactInquiryId") REFERENCES "ContactInquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "EmailLog_contactInquiryId_idx" ON "EmailLog"("contactInquiryId");
