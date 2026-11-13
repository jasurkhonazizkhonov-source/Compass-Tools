-- Inquiry submission details: the full IP address the server received through its trusted path for a public inquiry (Business Flights "Get In
-- Touch" or "CRM Inquiries") and the approximate, IP-derived location resolved from it.
-- Additive only: a new table with one row per ContactInquiry, its unique index and a foreign key. No existing table or column is changed, and
-- nothing reads this table except the Admin-only, masked and audited inquiry section.
-- A separate table (not columns on "ContactInquiry") so these values are never loaded with an ordinary inquiry query. Plaintext, like the
-- email/phone stored on the inquiry itself.
CREATE TABLE "InquirySubmissionInfo" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "ipVersion" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "countryCode" TEXT,
    "timeZone" TEXT,
    "geoSource" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InquirySubmissionInfo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InquirySubmissionInfo_inquiryId_key" ON "InquirySubmissionInfo"("inquiryId");

ALTER TABLE "InquirySubmissionInfo" ADD CONSTRAINT "InquirySubmissionInfo_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "ContactInquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
