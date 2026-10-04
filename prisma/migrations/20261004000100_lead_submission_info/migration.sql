-- Lead submission details captured by the website's flight request form: the
-- full IP address the server received, the platform's approximate (IP-derived,
-- never exact) location, and the currency the customer chose for their budget.
-- Additive only — a new table with one row per Lead, its unique index and a
-- foreign key. No existing table or column is changed, and nothing in the CRM
-- reads this table except the explicitly permission-gated lead section.
-- A separate table (not columns on "Lead") so these values are never loaded
-- along with an ordinary Lead query and can only reach a screen through that
-- gated path. Plaintext, like the Contact email/phone stored beside it: this is
-- a prospect's request, not the signer-evidence the encrypted IpCapture vault
-- exists for.
CREATE TABLE "LeadSubmissionInfo" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "ipVersion" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "countryCode" TEXT,
    "timeZone" TEXT,
    "geoSource" TEXT,
    "budgetCurrency" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSubmissionInfo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeadSubmissionInfo_leadId_key" ON "LeadSubmissionInfo"("leadId");

ALTER TABLE "LeadSubmissionInfo" ADD CONSTRAINT "LeadSubmissionInfo_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
