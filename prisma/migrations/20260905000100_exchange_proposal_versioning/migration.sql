-- Pass 26 — Exchange Proposal Versioning
-- Adds a new terminal QuoteStatus value (EXCHANGE_SUPERSEDED) and two new
-- columns on Quote enabling an unbounded supersession chain of exchange
-- proposals: isCurrentExchangeProposal (the "which one is active right
-- now" marker, backed by a composite unique index that gives a real
-- database-enforced "at most one current proposal per original" guarantee)
-- and supersededByQuoteId (the forward link from an old proposal to
-- whichever new one replaced it, for full audit history).
--
-- Postgres requires ALTER TYPE ... ADD VALUE to run outside of any
-- transaction block that also uses the new value — this migration only
-- adds the value and never references it in the same file, so it is safe
-- to apply as an ordinary sequential script (matches how every other
-- enum-value addition in this project's migration history has been
-- applied via `prisma db execute --file`).

-- AlterEnum
ALTER TYPE "QuoteStatus" ADD VALUE 'EXCHANGE_SUPERSEDED';

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN "isCurrentExchangeProposal" BOOLEAN,
ADD COLUMN "supersededByQuoteId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Quote_supersededByQuoteId_key" ON "Quote"("supersededByQuoteId");

-- CreateIndex
-- The actual concurrency-safety constraint: standard SQL unique-index NULL
-- semantics mean this only ever rejects two rows sharing the same
-- originalQuoteId that BOTH have isCurrentExchangeProposal = true (any
-- number of NULLs coexist freely) — a genuine partial-unique-index effect
-- without needing Prisma schema support for WHERE-clause indexes.
CREATE UNIQUE INDEX "Quote_originalQuoteId_isCurrentExchangeProposal_key" ON "Quote"("originalQuoteId", "isCurrentExchangeProposal");

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_supersededByQuoteId_fkey" FOREIGN KEY ("supersededByQuoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
