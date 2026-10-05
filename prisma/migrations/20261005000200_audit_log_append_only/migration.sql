-- Append-only audit trail for EVERY AuditLog row.
--
-- 20260926000400_card_vault_hardening already made card-vault audit rows (PaymentMethod, CARD_*, PAYMENT_*) impossible to
-- edit or delete. Every other audit row — IP reveals, role / permission / status changes, lead and booking deletions,
-- email actions — was only protected by the application never issuing an UPDATE or DELETE. This extends the same database
-- guard to all of them.
--
-- The one permitted UPDATE is the foreign-key action when an account is removed (AuditLog.actorId ... ON DELETE SET NULL):
-- it may clear actorId and change nothing else. Anything else — editing a row, deleting a row, rewriting metadata — raises.
--
-- What this does and does not give you: it resists application-level tampering, mistakes and a compromised application
-- credential that only reaches the app's own queries. It does NOT stop someone who can alter the database schema itself (drop
-- the trigger) or an administrator of the database provider; true tamper-evidence needs write-once (WORM) storage or an
-- external log sink, which is infrastructure (see docs/DEPLOYMENT.md).
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."actorId" IS NOT NULL
     AND NEW."actorId" IS NULL
     AND (NEW."id", NEW."action", NEW."entityType", NEW."entityId", NEW."metadata"::text, NEW."createdAt")
         IS NOT DISTINCT FROM
         (OLD."id", OLD."action", OLD."entityType", OLD."entityId", OLD."metadata"::text, OLD."createdAt") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit records are append-only';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AuditLog_card_append_only" ON "AuditLog";
DROP TRIGGER IF EXISTS "AuditLog_append_only" ON "AuditLog";
CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

DROP FUNCTION IF EXISTS card_audit_append_only();
