-- Idempotency bookkeeping for the authenticated website API (POST /api/v1/website/flight-inquiries, docs/WEBSITE_LEAD_API.md).
--
-- ADDITIVE and non-destructive: one new table and its foreign key. No existing table or row is touched. The table is written in the same
-- INSERT as the Lead it describes (a nested create), so a lead created through the API always has its fingerprint, and a lead
-- created any other way (the public browser endpoint, the website's direct write, an agent) simply has none.
--
-- "requestHash" is a SHA-256 digest of the canonical request - no customer data is stored here. A retry of the same Idempotency-Key with
-- the same request matches it (the existing lead is returned); the same key with a different request does not (409).
--
-- Rollback (only if nothing depends on it): DROP TABLE "LeadIngestFingerprint";

-- CreateTable
CREATE TABLE "LeadIngestFingerprint" (
    "leadId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadIngestFingerprint_pkey" PRIMARY KEY ("leadId")
);

-- AddForeignKey
ALTER TABLE "LeadIngestFingerprint" ADD CONSTRAINT "LeadIngestFingerprint_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
