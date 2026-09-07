-- Pass 16 §7 — required for the batched/resumable marketing-campaign send
-- architecture: guarantees the database itself can never hold two send
-- records for the same subscriber on the same campaign, even if two
-- "Continue Sending" invocations race. Verified against the live database
-- before writing this migration: zero existing (campaignId, subscriberId)
-- duplicates.
CREATE UNIQUE INDEX "MarketingCampaignSend_campaignId_subscriberId_key" ON "MarketingCampaignSend"("campaignId", "subscriberId");
