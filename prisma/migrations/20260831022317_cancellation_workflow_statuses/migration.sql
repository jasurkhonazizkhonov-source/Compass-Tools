-- Cancellation workflow — additive only.
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
-- --applied 20260831022317_cancellation_workflow_statuses` so migration
-- history stays consistent without touching them.
--
-- Splits the Cancellation workflow's single "approved == done" status into
-- its real stages (see QuoteStatus's own schema.prisma doc comments):
-- Admin/Manager approval no longer implies the flight has actually been
-- cancelled — CANCELLATION_CONFIRMED becomes the true terminal state, set
-- only once a Ticketing-area action confirms the segment(s) are actually
-- cancelled.

-- AlterEnum
ALTER TYPE "QuoteStatus" ADD VALUE 'CANCELLATION_APPROVED';
ALTER TYPE "QuoteStatus" ADD VALUE 'CANCELLATION_FORM_SENT';
ALTER TYPE "QuoteStatus" ADD VALUE 'CANCELLATION_SUBMITTED';
