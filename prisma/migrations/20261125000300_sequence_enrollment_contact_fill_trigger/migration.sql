-- Rollback and rolling-deploy safety for 20261125000100 (contact-only enrollment).
--
-- That migration made "SequenceEnrollment"."contactId" NOT NULL. The PREVIOUS release of the application does not know the column: while the new migration is applied and the old image is
-- still running (the minutes between `migrate deploy` and the restart), or after `deploy/rollback.sh` returns to the old image, its enrollment INSERTs would fail with a NOT NULL
-- violation and nobody could be enrolled. This trigger fills "contactId" from the lead when an INSERT names a lead but no contact - exactly what the old image does - and does nothing
-- otherwise (the new application always sets it). It changes no existing row and no behaviour of the new code. Not expressible in schema.prisma (Prisma does not model triggers), so it
-- lives only here; `deploy/check-migration-drift.sh` is unaffected.
-- Remove with: DROP TRIGGER "SequenceEnrollment_fill_contact" ON "SequenceEnrollment"; DROP FUNCTION sequence_enrollment_fill_contact();
CREATE FUNCTION sequence_enrollment_fill_contact() RETURNS trigger AS $$
BEGIN
  IF NEW."contactId" IS NULL AND NEW."leadId" IS NOT NULL THEN
    SELECT l."contactId" INTO NEW."contactId" FROM "Lead" l WHERE l."id" = NEW."leadId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SequenceEnrollment_fill_contact" BEFORE INSERT ON "SequenceEnrollment" FOR EACH ROW EXECUTE FUNCTION sequence_enrollment_fill_contact();
