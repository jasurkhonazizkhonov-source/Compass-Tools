-- Contact and Lead list views now sort by updatedAt (recency of last
-- activity) instead of createdAt. Add indexes to keep those sorted/paginated
-- queries efficient, matching the existing @@index([createdAt]) pattern.
CREATE INDEX "Contact_updatedAt_idx" ON "Contact"("updatedAt");
CREATE INDEX "Lead_updatedAt_idx" ON "Lead"("updatedAt");
