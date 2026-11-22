-- A campaign recipient whose message has not been sent yet can now be cancelled on its own (Campaign page -> Delivery Status -> Cancel next to the recipient). The status needs a value
-- of its own: reusing FAILED or SKIPPED_* would misreport what happened to that recipient.
-- Additive only: one new label on an existing enum. No row is read, rewritten or deleted, no column is added, no existing status changes meaning, and every historical outcome,
-- unsubscribe and suppression record is untouched. The worker only ever claims PENDING rows, so a CANCELLED row can never be sent.
-- Deployment order: apply this migration BEFORE the new application image starts serving (deploy.sh --migrate does that). The new code reads and writes the label; an old image never
-- sees it. Rollback: PostgreSQL cannot remove an enum label; if the application is rolled back the label simply stays unused (harmless).
ALTER TYPE "MarketingSendStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
