-- AlterEnum
-- The "New Flight Request" email sent to the agent who accepts a website
-- lead from the queue gets its own EmailLog type, distinct from
-- LEAD_REASSIGNMENT (a manual hand-off) so the two are never confused in the
-- audit trail. Additive only; no existing row or column changes.
ALTER TYPE "EmailType" ADD VALUE 'NEW_LEAD_ASSIGNMENT';
