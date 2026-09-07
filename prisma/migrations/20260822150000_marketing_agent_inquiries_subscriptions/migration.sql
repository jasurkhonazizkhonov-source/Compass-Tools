-- New role: MARKETING_AGENT (sidebar access limited to Subscriptions +
-- Accounts only — see src/lib/permissions.ts and sidebar.tsx).
ALTER TYPE "AccountRole" ADD VALUE 'MARKETING_AGENT';

-- Account.location: office/city the employee works out of, admin-editable,
-- shown on Accounts and used in the booking-confirmation profit email.
-- Account.commissionPercent: admin-set commission rate applied to a
-- CONFIRMED booking's profit when its quote was originally sent by this
-- account. Both nullable/additive — existing accounts simply have no value
-- until an admin sets one.
ALTER TABLE "Account" ADD COLUMN "location" TEXT;
ALTER TABLE "Account" ADD COLUMN "commissionPercent" DECIMAL(5,2);

-- Get in Touch — public-website inquiry inbox, admin-only in the CRM.
CREATE TYPE "InquirySubject" AS ENUM ('GENERAL_INQUIRY', 'FLIGHT_REQUEST_HELP', 'EXISTING_BOOKING', 'CORPORATE_TRAVEL', 'OTHER');
CREATE TYPE "InquiryStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'REPLIED', 'RESOLVED', 'CLOSED');

CREATE TABLE "ContactInquiry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "subject" "InquirySubject" NOT NULL,
    "message" TEXT NOT NULL,
    "status" "InquiryStatus" NOT NULL DEFAULT 'NEW',
    "assignedAdminId" TEXT,
    "readAt" TIMESTAMP(3),
    "matchedContactId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactInquiry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InquiryNote" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InquiryNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContactInquiry_companyId_idx" ON "ContactInquiry"("companyId");
CREATE INDEX "ContactInquiry_status_idx" ON "ContactInquiry"("status");
CREATE INDEX "ContactInquiry_matchedContactId_idx" ON "ContactInquiry"("matchedContactId");
CREATE INDEX "InquiryNote_inquiryId_idx" ON "InquiryNote"("inquiryId");

ALTER TABLE "ContactInquiry" ADD CONSTRAINT "ContactInquiry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactInquiry" ADD CONSTRAINT "ContactInquiry_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactInquiry" ADD CONSTRAINT "ContactInquiry_matchedContactId_fkey" FOREIGN KEY ("matchedContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InquiryNote" ADD CONSTRAINT "InquiryNote_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "ContactInquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InquiryNote" ADD CONSTRAINT "InquiryNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Subscriptions / Marketing Campaigns — separate from CRM Sequences,
-- admin-/marketing-agent-only. Sends reuse the existing per-account Gmail
-- sending path (src/server/email/service.ts).
CREATE TYPE "SubscriberStatus" AS ENUM ('SUBSCRIBED', 'UNSUBSCRIBED');
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SENDING', 'SENT');
CREATE TYPE "MarketingSendStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED_UNSUBSCRIBED');

CREATE TABLE "Subscriber" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "SubscriberStatus" NOT NULL DEFAULT 'SUBSCRIBED',
    "source" TEXT,
    "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unsubscribedAt" TIMESTAMP(3),
    "unsubscribeToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscriber_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "htmlContent" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "sentAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketingCampaignSend" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "status" "MarketingSendStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingCampaignSend_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscriber_unsubscribeToken_key" ON "Subscriber"("unsubscribeToken");
CREATE INDEX "Subscriber_companyId_idx" ON "Subscriber"("companyId");
CREATE INDEX "Subscriber_status_idx" ON "Subscriber"("status");
CREATE UNIQUE INDEX "Subscriber_companyId_email_key" ON "Subscriber"("companyId", "email");
CREATE INDEX "MarketingCampaign_companyId_idx" ON "MarketingCampaign"("companyId");
CREATE INDEX "MarketingCampaignSend_campaignId_idx" ON "MarketingCampaignSend"("campaignId");
CREATE INDEX "MarketingCampaignSend_subscriberId_idx" ON "MarketingCampaignSend"("subscriberId");

ALTER TABLE "Subscriber" ADD CONSTRAINT "Subscriber_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MarketingCampaignSend" ADD CONSTRAINT "MarketingCampaignSend_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MarketingCampaignSend" ADD CONSTRAINT "MarketingCampaignSend_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
