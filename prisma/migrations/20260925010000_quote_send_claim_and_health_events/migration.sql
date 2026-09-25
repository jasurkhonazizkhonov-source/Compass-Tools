-- Additive only: two new tables and one enum. No existing column, table or
-- row is touched.

-- CreateEnum
CREATE TYPE "HealthSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "QuoteSendClaim" (
    "quoteId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteSendClaim_pkey" PRIMARY KEY ("quoteId","recipientEmail")
);

-- CreateTable
CREATE TABLE "HealthEvent" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "HealthSeverity" NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "HealthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HealthEvent_resolvedAt_severity_lastSeenAt_idx" ON "HealthEvent"("resolvedAt", "severity", "lastSeenAt");

-- CreateIndex
CREATE INDEX "HealthEvent_fingerprint_idx" ON "HealthEvent"("fingerprint");

-- CreateIndex
CREATE INDEX "HealthEvent_lastSeenAt_idx" ON "HealthEvent"("lastSeenAt");

-- At most ONE open incident per fingerprint: the atomic dedupe target for
-- INSERT ... ON CONFLICT. (Partial index; Prisma's schema language cannot
-- express it, which is why it lives only in this migration.)
CREATE UNIQUE INDEX "HealthEvent_open_fingerprint_key" ON "HealthEvent"("fingerprint") WHERE "resolvedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "QuoteSendClaim" ADD CONSTRAINT "QuoteSendClaim_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
