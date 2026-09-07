-- Ticketing Agent and Flight Expert no longer participate in lead
-- distribution (see src/server/actions/lead-queue.ts). Deactivate any
-- pre-existing LeadQueueEntry rows for accounts currently holding those
-- roles so a stale row from before this restriction can't be picked up by
-- claimNextWorker's own defense-in-depth role filter or linger as
-- misleading state. Rows are deactivated, not deleted, preserving
-- leadsAssignedCount history.
UPDATE "LeadQueueEntry" lqe
SET "isActive" = false
FROM "Account" a
WHERE a."id" = lqe."accountId"
  AND a."role" IN ('TICKETING_AGENT', 'FLIGHT_EXPERT')
  AND lqe."isActive" = true;
