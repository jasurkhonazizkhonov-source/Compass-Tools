
-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "queueDistributedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "leadId" TEXT;

-- CreateTable
CREATE TABLE "LeadQueueEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAssignedAt" TIMESTAMP(3),
    "leadsAssignedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadQueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeadQueueEntry_accountId_key" ON "LeadQueueEntry"("accountId");

-- CreateIndex
CREATE INDEX "LeadQueueEntry_isActive_idx" ON "LeadQueueEntry"("isActive");

-- CreateIndex
CREATE INDEX "LeadQueueEntry_isActive_lastAssignedAt_idx" ON "LeadQueueEntry"("isActive", "lastAssignedAt");

-- CreateIndex
CREATE INDEX "Lead_source_assignedAgentId_queueDistributedAt_idx" ON "Lead"("source", "assignedAgentId", "queueDistributedAt");

-- CreateIndex
CREATE INDEX "Notification_leadId_idx" ON "Notification"("leadId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadQueueEntry" ADD CONSTRAINT "LeadQueueEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

