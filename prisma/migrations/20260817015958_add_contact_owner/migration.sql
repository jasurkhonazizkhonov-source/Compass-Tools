-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "ownerId" TEXT;

-- Backfill existing contacts from their most-recently-updated lead's
-- assigned agent, rather than leaving every existing contact "Unassigned"
-- (which would be misleading — most already have a de-facto owner via
-- their leads). Contacts with no leads, or whose leads have no assigned
-- agent, are left NULL (genuinely unassigned).
UPDATE "Contact" c SET "ownerId" = (
  SELECT l."assignedAgentId" FROM "Lead" l
  WHERE l."contactId" = c.id AND l."assignedAgentId" IS NOT NULL
  ORDER BY l."updatedAt" DESC
  LIMIT 1
);

-- CreateIndex
CREATE INDEX "Contact_ownerId_idx" ON "Contact"("ownerId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
