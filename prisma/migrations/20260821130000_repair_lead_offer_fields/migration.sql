-- Repairs migration 20260821000000_add_lead_offer_fields, whose DDL is
-- recorded as successfully applied in _prisma_migrations but whose actual
-- effects (the three offeredToId/offeredAt/offerExpiresAt columns, their FK,
-- and their index) are absent from the live database — confirmed via direct
-- information_schema/pg_constraint/pg_indexes inspection. All other tables
-- and data (Lead/Contact/Quote row counts, Contact.companyId from a later
-- migration, LeadQueueEntry's indexes) are intact, so this was isolated to
-- that one migration's effects rather than a broader reset. Using IF NOT
-- EXISTS/guards throughout so this is safe to run regardless of exactly
-- which of the three pieces (columns/FK/index) survived — purely additive,
-- no existing Lead rows are touched or lost.

ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "offeredToId" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "offeredAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "offerExpiresAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Lead_offeredToId_fkey') THEN
    ALTER TABLE "Lead" ADD CONSTRAINT "Lead_offeredToId_fkey" FOREIGN KEY ("offeredToId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Lead_offeredToId_idx" ON "Lead"("offeredToId");
