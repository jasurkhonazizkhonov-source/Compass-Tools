-- Additive and reversible (DROP INDEX): two indexes for the sender-quota counts (server/sender-quota.ts countCampaignSends). Measured on PostgreSQL 17.11 with 90,000 send rows in the history of one
-- sender: the count dropped from 68 ms to 18 ms and no longer grows with the history. No data is touched.
CREATE INDEX "MarketingCampaignSend_status_sentAt_idx" ON "MarketingCampaignSend"("status", "sentAt");
CREATE INDEX "MarketingCampaignSend_status_lastAttemptAt_idx" ON "MarketingCampaignSend"("status", "lastAttemptAt");
