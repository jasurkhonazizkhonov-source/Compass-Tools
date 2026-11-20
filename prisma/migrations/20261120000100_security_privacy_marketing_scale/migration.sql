-- Admin failed-sign-in log, customer-email reveal audit + daily allowance, unlimited-email permission, subscriber import jobs, campaign templates and the
-- queue/analytics columns of the marketing campaign pipeline. ADDITIVE ONLY: new tables, new nullable or defaulted columns, new enum values and indexes. No existing
-- column, row, index or constraint is changed or dropped; the new Account permission defaults to FALSE (nobody gains access). Generated offline (schema-to-schema diff);
-- not applied to any database. See docs/COMPASS_SECURITY_PRIVACY_MARKETING_IMPLEMENTATION_REPORT.md.

-- CreateEnum
CREATE TYPE "SubscriberImportStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "SubscriberStatus" ADD VALUE 'SUPPRESSED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CampaignStatus" ADD VALUE 'SCHEDULED';
ALTER TYPE "CampaignStatus" ADD VALUE 'QUEUED';
ALTER TYPE "CampaignStatus" ADD VALUE 'PAUSED';
ALTER TYPE "CampaignStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MarketingSendStatus" ADD VALUE 'SKIPPED_SUPPRESSED';
ALTER TYPE "MarketingSendStatus" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "unlimitedCustomerEmailAccess" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Subscriber" ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastCampaignSentAt" TIMESTAMP(3),
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "suppressedAt" TIMESTAMP(3),
ADD COLUMN     "suppressionReason" TEXT;

-- AlterTable
ALTER TABLE "MarketingCampaign" ADD COLUMN     "audienceComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "audienceCursor" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "category" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "description" TEXT,
ADD COLUMN     "designJson" JSONB,
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "previewText" TEXT,
ADD COLUMN     "queuedAt" TIMESTAMP(3),
ADD COLUMN     "replyTo" TEXT,
ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ADD COLUMN     "senderName" TEXT,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MarketingCampaignSend" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "providerMessageId" TEXT;

-- CreateTable
CREATE TABLE "FailedSignInEvent" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT,
    "method" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "attemptedEmail" VARCHAR(254),
    "verifiedEmail" VARCHAR(254),
    "verifiedFullName" VARCHAR(200),
    "ipAddress" VARCHAR(45),
    "ipVersion" VARCHAR(2),
    "city" VARCHAR(120),
    "region" VARCHAR(120),
    "country" VARCHAR(120),
    "countryCode" VARCHAR(2),
    "geoSource" VARCHAR(120),
    "attemptKey" VARCHAR(32),
    "repeatCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "FailedSignInEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerEmailRevealEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "leadId" TEXT,
    "method" TEXT NOT NULL,
    "dayKey" VARCHAR(10) NOT NULL,
    "correlationId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerEmailRevealEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerEmailRevealUsage" (
    "userId" TEXT NOT NULL,
    "dayKey" VARCHAR(10) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CustomerEmailRevealUsage_pkey" PRIMARY KEY ("userId","dayKey")
);

-- CreateTable
CREATE TABLE "SubscriberImportJob" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdById" TEXT,
    "status" "SubscriberImportStatus" NOT NULL DEFAULT 'QUEUED',
    "source" TEXT NOT NULL DEFAULT 'PASTE',
    "payload" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "duplicateInFile" INTEGER NOT NULL DEFAULT 0,
    "existingRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedUnsubscribedOrSuppressed" INTEGER NOT NULL DEFAULT 0,
    "nextRow" INTEGER NOT NULL DEFAULT 0,
    "errorReport" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SubscriberImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "category" VARCHAR(80),
    "designJson" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FailedSignInEvent_occurredAt_idx" ON "FailedSignInEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "FailedSignInEvent_ipAddress_occurredAt_idx" ON "FailedSignInEvent"("ipAddress", "occurredAt");

-- CreateIndex
CREATE INDEX "FailedSignInEvent_verifiedEmail_occurredAt_idx" ON "FailedSignInEvent"("verifiedEmail", "occurredAt");

-- CreateIndex
CREATE INDEX "FailedSignInEvent_attemptedEmail_occurredAt_idx" ON "FailedSignInEvent"("attemptedEmail", "occurredAt");

-- CreateIndex
CREATE INDEX "FailedSignInEvent_reasonCode_occurredAt_idx" ON "FailedSignInEvent"("reasonCode", "occurredAt");

-- CreateIndex
CREATE INDEX "FailedSignInEvent_attemptKey_idx" ON "FailedSignInEvent"("attemptKey");

-- CreateIndex
CREATE INDEX "CustomerEmailRevealEvent_userId_dayKey_idx" ON "CustomerEmailRevealEvent"("userId", "dayKey");

-- CreateIndex
CREATE INDEX "CustomerEmailRevealEvent_contactId_idx" ON "CustomerEmailRevealEvent"("contactId");

-- CreateIndex
CREATE INDEX "CustomerEmailRevealEvent_createdAt_idx" ON "CustomerEmailRevealEvent"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerEmailRevealEvent_userId_contactId_dayKey_key" ON "CustomerEmailRevealEvent"("userId", "contactId", "dayKey");

-- CreateIndex
CREATE INDEX "SubscriberImportJob_companyId_createdAt_idx" ON "SubscriberImportJob"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriberImportJob_status_idx" ON "SubscriberImportJob"("status");

-- CreateIndex
CREATE INDEX "CampaignTemplate_companyId_category_idx" ON "CampaignTemplate"("companyId", "category");

-- CreateIndex
CREATE INDEX "Subscriber_companyId_status_idx" ON "Subscriber"("companyId", "status");

-- CreateIndex
CREATE INDEX "MarketingCampaignSend_campaignId_status_idx" ON "MarketingCampaignSend"("campaignId", "status");

