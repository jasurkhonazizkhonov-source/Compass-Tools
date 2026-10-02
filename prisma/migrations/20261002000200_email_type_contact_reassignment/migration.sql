-- AlterEnum
-- Pure contact reassignments get their own EmailLog type so a contact
-- hand-off is never logged as (or confused with) a lead hand-off
-- (LEAD_REASSIGNMENT) or a fresh website lead (NEW_LEAD_ASSIGNMENT).
-- Additive only; no existing row or column changes.
ALTER TYPE "EmailType" ADD VALUE 'CONTACT_REASSIGNMENT';
