-- Lead documents stored in private Cloudflare R2 (see docs/LEAD_ATTACHMENTS.md). Extends the existing, never-used "Attachment" table
-- (an empty placeholder behind the Lead / Contact "Files" tab: no code ever wrote to it) instead of adding a competing table.
-- ADDITIVE and non-destructive: no column or row is dropped or rewritten; the one relaxed constraint is fileUrl NOT NULL -> NULL
-- (R2-backed rows have no URL by design - the object key is server-side only and files are only ever reached through an authorised route).
--
-- Rows that already exist (legacy placeholders) are marked READY, as they were; they have no storageKey, so no screen can list or open them.
-- New rows start PENDING and become READY only after the server has verified the stored object.
--
-- Rollback: DROP the constraint/indexes/columns added below and the enum (nothing else references them), then SET NOT NULL on
-- "fileUrl" only if no R2-backed row exists.

CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING', 'READY');

ALTER TABLE "Attachment" ALTER COLUMN "fileUrl" DROP NOT NULL;

ALTER TABLE "Attachment"
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "companyId" TEXT,
  ADD COLUMN "storageKey" TEXT,
  ADD COLUMN "status" "AttachmentStatus" NOT NULL DEFAULT 'READY';

-- Existing rows keep READY; every row created from now on starts PENDING.
ALTER TABLE "Attachment" ALTER COLUMN "status" SET DEFAULT 'PENDING';

CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");
DROP INDEX "Attachment_leadId_idx";
CREATE INDEX "Attachment_leadId_createdAt_idx" ON "Attachment"("leadId", "createdAt");
CREATE INDEX "Attachment_companyId_idx" ON "Attachment"("companyId");
CREATE INDEX "Attachment_status_createdAt_idx" ON "Attachment"("status", "createdAt");

-- A stored object must always belong to a Lead and a company: the authoritative Attachment -> Lead -> Company chain can never be
-- missing for a row that points at bytes in storage.
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_storage_requires_lead_and_company"
  CHECK ("storageKey" IS NULL OR ("leadId" IS NOT NULL AND "companyId" IS NOT NULL));
