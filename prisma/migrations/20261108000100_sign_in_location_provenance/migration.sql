-- Provenance of an Account's last sign-in location: which geolocation database produced it, and when.
-- Additive only: two nullable columns, nothing dropped or rewritten, no backfill, existing rows stay valid (NULL = "not recorded").
-- The location text columns themselves (city, region, country, country code, time zone) already exist.

ALTER TABLE "Account"
  ADD COLUMN "lastSignInLocationSource" TEXT,
  ADD COLUMN "lastSignInLocationAt" TIMESTAMP(3);
