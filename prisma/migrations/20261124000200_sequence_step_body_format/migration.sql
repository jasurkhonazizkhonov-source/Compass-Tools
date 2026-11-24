-- Sequence steps can now be written in the visual email editor (rich text, images, buttons). The body stays in the same column; this says how to read it.
--
-- ADDITIVE ONLY: one new enum and one new column with a DEFAULT of 'TEXT', so every existing step keeps being read and sent exactly as before (plain text paragraphs). No row is
-- rewritten or deleted. Deployment order: apply BEFORE the new image serves. Rollback: an older image ignores the column; a step saved as HTML would then be read as plain text
-- (so roll back only before anyone has saved a visual step, or re-save it as text).
CREATE TYPE "StepBodyFormat" AS ENUM ('TEXT', 'HTML');
ALTER TABLE "SequenceStep" ADD COLUMN "bodyFormat" "StepBodyFormat" NOT NULL DEFAULT 'TEXT';
