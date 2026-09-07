-- Contact.companyId: the multi-tenant anchor for the whole Lead/Quote/
-- Booking ownership chain (see the field's doc comment in schema.prisma
-- and src/server/visibility.ts). Contact.ownerId is nullable (a brand-new
-- unassigned lead has no owner yet), so it cannot be the sole basis for
-- company-scoped visibility — this column can never be null.

-- 1. Add nullable first so existing rows aren't rejected outright.
ALTER TABLE "Contact" ADD COLUMN "companyId" TEXT;

-- 2. Backfill: prefer the existing owner's company where an owner is set;
-- every environment at the time of this migration has exactly one Company
-- row ('default-company', seeded in 20260819070000_company_multitenancy),
-- so any remaining unowned Contact also falls back to it. A genuinely
-- multi-company deployment created after this migration will never hit
-- the fallback branch, since every future Contact is created with an
-- explicit companyId from the start (see createLead in
-- src/server/actions/leads.ts).
UPDATE "Contact" c
SET "companyId" = COALESCE(
  (SELECT a."companyId" FROM "Account" a WHERE a."id" = c."ownerId"),
  'default-company'
)
WHERE c."companyId" IS NULL;

-- 3. Enforce NOT NULL now that every row has a value.
ALTER TABLE "Contact" ALTER COLUMN "companyId" SET NOT NULL;

-- 4. FK + index, matching the pattern already used for Account.companyId.
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Contact_companyId_idx" ON "Contact"("companyId");
