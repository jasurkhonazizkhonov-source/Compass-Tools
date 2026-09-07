-- Pass 28 — atomic fixed-window rate-limit counter table. Purely additive
-- (new table only, no changes to any existing table) — replaces the
-- AuditLog-backed "count rows, then create one" approach in
-- src/server/security/rate-limit.ts with a real atomic upsert-increment,
-- closing the narrow check-then-act race the previous approach had under a
-- genuinely simultaneous burst from the same IP. See the model's own doc
-- comment in schema.prisma for the full design rationale.

-- CreateTable
CREATE TABLE "RateLimitCounter" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitCounter_key_key" ON "RateLimitCounter"("key");

-- CreateIndex
CREATE INDEX "RateLimitCounter_expiresAt_idx" ON "RateLimitCounter"("expiresAt");
