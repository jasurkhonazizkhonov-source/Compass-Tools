-- Part 10: EmailLog entries for Marketing Campaign sends get their own
-- distinct type, alongside MarketingCampaignSend's own per-recipient
-- delivery tracking.
ALTER TYPE "EmailType" ADD VALUE 'MARKETING_CAMPAIGN';
