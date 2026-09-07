-- Quote.sentByAgentId: who actually sent this quote to the customer,
-- captured once at send time and never overwritten by a later
-- reassignment (unlike agentId). Backfilled from the current agentId for
-- existing non-draft quotes as the best available reconstruction — purely
-- additive, no existing rows lost or altered beyond this one new column.
ALTER TABLE "Quote" ADD COLUMN "sentByAgentId" TEXT;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_sentByAgentId_fkey" FOREIGN KEY ("sentByAgentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Quote_sentByAgentId_idx" ON "Quote"("sentByAgentId");

UPDATE "Quote" SET "sentByAgentId" = "agentId" WHERE "status" != 'DRAFT' AND "agentId" IS NOT NULL AND "sentByAgentId" IS NULL;

-- Company.logoEmailData: the email-sized logo variant stored as raw bytes
-- so it can be embedded directly in outgoing emails as a data: URI,
-- instead of a file-path URL that external mail clients can't reach.
-- Nullable/additive — existing companies simply have no value here until
-- their next logo upload, and fall back to the existing URL-based behavior.
ALTER TABLE "Company" ADD COLUMN "logoEmailData" BYTEA;
