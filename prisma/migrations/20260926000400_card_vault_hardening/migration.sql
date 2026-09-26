-- Card vault hardening. Additive and data-safe: nothing is dropped, no existing
-- row is modified, and every new constraint is created NOT VALID first so a
-- pre-existing row can never make this migration fail (it is validated only
-- when no existing row violates it).

-- 1. Purge marker. When a card is removed its encrypted number is destroyed and
--    replaced by a tombstone; this records when.
ALTER TABLE "PaymentMethod" ADD COLUMN IF NOT EXISTS "panPurgedAt" TIMESTAMP(3);

-- 2. The encrypted-number column may never hold something that looks like a
--    plaintext card number (12-23 digits/spaces/dashes) or an implausibly short
--    value. Real values are a versioned envelope ("cv2.<keyId>.<payload>"), a
--    legacy base64 blob (>= 40 chars) or the tombstone "cv2.purged".
ALTER TABLE "PaymentMethod" DROP CONSTRAINT IF EXISTS "PaymentMethod_encryptedPan_not_plaintext";
ALTER TABLE "PaymentMethod"
  ADD CONSTRAINT "PaymentMethod_encryptedPan_not_plaintext"
  CHECK ("encryptedPan" !~ '^[0-9 -]{12,23}$' AND length("encryptedPan") >= 10) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PaymentMethod"
    WHERE "encryptedPan" ~ '^[0-9 -]{12,23}$' OR length("encryptedPan") < 10
  ) THEN
    ALTER TABLE "PaymentMethod" VALIDATE CONSTRAINT "PaymentMethod_encryptedPan_not_plaintext";
  END IF;
END $$;

-- 3. Append-only card-vault audit trail. Rows about payment methods, card
--    encryption/decryption/rotation and payment-permission changes cannot be
--    edited or deleted through the application. (The one permitted UPDATE is
--    the foreign-key SET NULL of actorId if an account were ever removed.)
--    This resists application-level tampering and mistakes; it does not stop
--    someone who can alter the database schema itself.
CREATE OR REPLACE FUNCTION card_audit_append_only() RETURNS trigger AS $fn$
BEGIN
  IF OLD."entityType" = 'PaymentMethod'
     OR OLD."action" LIKE 'CARD\_%' ESCAPE '\'
     OR OLD."action" LIKE 'PAYMENT\_%' ESCAPE '\' THEN
    IF TG_OP = 'UPDATE'
       AND NEW."actorId" IS NULL
       AND (NEW."id", NEW."action", NEW."entityType", NEW."entityId", NEW."metadata"::text, NEW."createdAt")
           IS NOT DISTINCT FROM
           (OLD."id", OLD."action", OLD."entityType", OLD."entityId", OLD."metadata"::text, OLD."createdAt") THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'card vault audit records are append-only';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AuditLog_card_append_only" ON "AuditLog";
CREATE TRIGGER "AuditLog_card_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION card_audit_append_only();
