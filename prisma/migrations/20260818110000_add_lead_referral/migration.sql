-- AlterTable: which Contact referred this Lead in (only meaningful when
-- source == REFERRAL). Nullable, SetNull on delete so removing the
-- referring contact never blocks or cascades onto the leads they referred.
ALTER TABLE "Lead" ADD COLUMN "referredByContactId" TEXT;

CREATE INDEX "Lead_referredByContactId_idx" ON "Lead"("referredByContactId");

ALTER TABLE "Lead" ADD CONSTRAINT "Lead_referredByContactId_fkey"
  FOREIGN KEY ("referredByContactId") REFERENCES "Contact"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
