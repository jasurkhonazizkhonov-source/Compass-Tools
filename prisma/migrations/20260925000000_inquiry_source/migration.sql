-- Records which public form an inquiry came from, so the Business Flights
-- website "Get In Touch" inbox and the CRM website "CRM Inquiries" inbox stay
-- separate even though both are stored in ContactInquiry.
--
-- Purely additive and non-destructive: a new enum, one NOT NULL column with a
-- default, and an index. Every existing row (all of which pre-date the CRM
-- website form) becomes BUSINESS_FLIGHTS_WEBSITE, and the separate Business
-- Flights website app — which inserts into this table without this column —
-- keeps working unchanged because the default applies.
CREATE TYPE "InquirySource" AS ENUM ('BUSINESS_FLIGHTS_WEBSITE', 'CRM_WEBSITE');

ALTER TABLE "ContactInquiry" ADD COLUMN "source" "InquirySource" NOT NULL DEFAULT 'BUSINESS_FLIGHTS_WEBSITE';

CREATE INDEX "ContactInquiry_companyId_source_createdAt_idx" ON "ContactInquiry"("companyId", "source", "createdAt");
