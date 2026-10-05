-- Last successful sign-in details on Account, and a record of why a session token stopped working.
-- Additive only: every new column is nullable (existing accounts stay valid), nothing is dropped or rewritten, and the
-- existing session columns are untouched.

ALTER TABLE "Account"
  ADD COLUMN "lastSignInAt" TIMESTAMP(3),
  ADD COLUMN "lastSignInIp" TEXT,
  ADD COLUMN "lastSignInCity" TEXT,
  ADD COLUMN "lastSignInRegion" TEXT,
  ADD COLUMN "lastSignInCountry" TEXT,
  ADD COLUMN "lastSignInCountryCode" TEXT,
  ADD COLUMN "lastSignInTimeZone" TEXT;

-- An account that currently has a session has, by definition, signed in at that moment: start its "last sign in" there so
-- the Users table is not blank for people who are signed in when this ships. (The IP/location were never captured, so they stay empty.)
UPDATE "Account" SET "lastSignInAt" = "sessionCreatedAt" WHERE "sessionCreatedAt" IS NOT NULL AND "lastSignInAt" IS NULL;

CREATE TYPE "SessionRevocationReason" AS ENUM ('SUPERSEDED', 'SIGNED_OUT_ALL');

CREATE TABLE "RevokedSession" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "reason" "SessionRevocationReason" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RevokedSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RevokedSession_tokenHash_key" ON "RevokedSession"("tokenHash");
CREATE INDEX "RevokedSession_createdAt_idx" ON "RevokedSession"("createdAt");
CREATE INDEX "RevokedSession_accountId_idx" ON "RevokedSession"("accountId");

ALTER TABLE "RevokedSession" ADD CONSTRAINT "RevokedSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
