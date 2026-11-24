-- Contact-only sequence enrollment: a SequenceEnrollment is now ALWAYS about a Contact, and about a Lead only when it was made through one.
--
-- Safe for existing data, in this order:
--   1. add "contactId" as nullable,
--   2. backfill it from each existing enrollment's lead (every existing row has a lead, and every lead has a contact: NOT NULL + FK),
--   3. only then make it NOT NULL (the statement fails, changing nothing, if any row could not be filled),
--   4. relax "leadId" to nullable (existing rows keep their lead; nothing is deleted or rewritten),
--   5. add the foreign key and the index.
-- The Lead foreign key keeps ON DELETE CASCADE (deleting a lead still removes the enrollments made through it, as before); the new Contact foreign key is ON DELETE CASCADE too,
-- so deleting a contact removes its contact-only enrollments (its lead-based ones already went with its leads).
-- Rollback (only needed before any contact-only enrollment exists): DELETE FROM "SequenceEnrollment" WHERE "leadId" IS NULL; then reverse the ALTERs below. Nothing here touches the
-- sent-email history ("SequenceStepLog") or the replies ("SequenceReply").

ALTER TABLE "SequenceEnrollment" ADD COLUMN "contactId" TEXT;

UPDATE "SequenceEnrollment" e SET "contactId" = l."contactId" FROM "Lead" l WHERE l."id" = e."leadId";

ALTER TABLE "SequenceEnrollment" ALTER COLUMN "contactId" SET NOT NULL;
ALTER TABLE "SequenceEnrollment" ALTER COLUMN "leadId" DROP NOT NULL;

ALTER TABLE "SequenceEnrollment" ADD CONSTRAINT "SequenceEnrollment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SequenceEnrollment_contactId_idx" ON "SequenceEnrollment"("contactId");

-- Last-resort database guarantee for the duplicate rule of contact-only enrollments: at most ONE ACTIVE contact-only enrollment per contact and sequence, whatever the application
-- does (double click, two workers, two Admins). A partial unique index: Prisma's schema language cannot express it, so it lives only here. Lead-based enrollments keep their existing
-- application-level rule (an advisory lock per sequence and lead), which this does not touch.
CREATE UNIQUE INDEX "SequenceEnrollment_one_active_contact_only" ON "SequenceEnrollment"("sequenceId", "contactId") WHERE "leadId" IS NULL AND "status" = 'ACTIVE';
