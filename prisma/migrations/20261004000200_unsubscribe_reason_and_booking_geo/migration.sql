-- Additive only: nullable columns and one enum value. No existing row is changed or backfilled —
-- historical signing events and subscribers keep NULL (no location or reason is ever invented).

-- Approximate IP-derived location, stored with each signing event.
ALTER TABLE "IpCapture" ADD COLUMN "geoCity" TEXT, ADD COLUMN "geoRegion" TEXT, ADD COLUMN "geoCountry" TEXT, ADD COLUMN "geoCountryCode" TEXT, ADD COLUMN "geoTimeZone" TEXT, ADD COLUMN "geoSource" TEXT;

-- Optional customer-provided unsubscribe reason, plus the staff follow-up marker.
ALTER TABLE "Subscriber" ADD COLUMN "unsubscribeReasonCategory" TEXT, ADD COLUMN "unsubscribeReason" VARCHAR(1000), ADD COLUMN "unsubscribeSource" TEXT, ADD COLUMN "unsubscribeRespondedAt" TIMESTAMP(3), ADD COLUMN "unsubscribeRespondedById" TEXT;

-- A staff member's personal reply to an unsubscribed subscriber.
ALTER TYPE "EmailType" ADD VALUE 'SUBSCRIBER_EMAIL';
