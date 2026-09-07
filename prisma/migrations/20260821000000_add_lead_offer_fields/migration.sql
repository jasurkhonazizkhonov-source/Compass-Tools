-- The 60-second lead-acceptance offer: a lead has at most one live offer at
-- a time, tracked directly on the row rather than in a separate table.
-- Purely additive, all nullable — existing rows are unaffected.

ALTER TABLE "Lead" ADD COLUMN "offeredToId" TEXT;
ALTER TABLE "Lead" ADD COLUMN "offeredAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "offerExpiresAt" TIMESTAMP(3);

ALTER TABLE "Lead" ADD CONSTRAINT "Lead_offeredToId_fkey" FOREIGN KEY ("offeredToId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Lead_offeredToId_idx" ON "Lead"("offeredToId");
