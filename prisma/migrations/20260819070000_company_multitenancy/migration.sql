-- CreateEnum
CREATE TYPE "LogoProcessingStatus" AS ENUM ('NONE', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "phone" TEXT,
    "brandColor" TEXT,
    "logoOriginalUrl" TEXT,
    "logoEmailUrl" TEXT,
    "logoWebUrl" TEXT,
    "logoIconUrl" TEXT,
    "logoProcessingStatus" "LogoProcessingStatus" NOT NULL DEFAULT 'NONE',
    "logoProcessingError" TEXT,
    "signatureTemplate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- Seed the one default Company from the previously-hardcoded COMPANY
-- constant (src/lib/company-config.ts) so existing behavior is preserved
-- exactly until an admin explicitly changes something in the new Company
-- settings page.
INSERT INTO "Company" ("id", "name", "website", "phone", "brandColor", "signatureTemplate", "updatedAt")
VALUES (
  'default-company',
  'Business Flights Travel',
  'https://www.businessflights.travel',
  '+1 (000) 000-0000',
  '#1c3a5e',
  E'Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}',
  CURRENT_TIMESTAMP
);

-- AlterTable: add companyId as nullable first so existing rows can be
-- backfilled before the NOT NULL constraint is applied.
ALTER TABLE "Account" ADD COLUMN "companyId" TEXT;

UPDATE "Account" SET "companyId" = 'default-company' WHERE "companyId" IS NULL;

ALTER TABLE "Account" ALTER COLUMN "companyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Account_companyId_idx" ON "Account"("companyId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DropTable: CompanySettings is superseded by Company. Its only consumer
-- (getCompanyLogoUrl) is rewritten in the same change to read from
-- Company instead.
DROP TABLE "CompanySettings";
