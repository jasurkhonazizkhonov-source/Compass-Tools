-- Manager teams: a Travel Agent can be explicitly assigned to one Manager.
-- Additive only: one nullable column, one self-referencing foreign key
-- (SET NULL, so deleting a manager never deletes an agent), one index.
-- Every existing account starts on nobody's team (NULL).
ALTER TABLE "Account" ADD COLUMN "managerId" TEXT;

CREATE INDEX "Account_managerId_idx" ON "Account"("managerId");

ALTER TABLE "Account" ADD CONSTRAINT "Account_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
