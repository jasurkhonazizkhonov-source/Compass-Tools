-- Per-user permission: may this account change a Lead's / Contact's phone numbers and email addresses? Set by an Administrator on the Users page.
-- Additive only: one new NOT NULL column with a default, so existing rows are filled in by the same statement and no existing column, row or index
-- is touched. DEFAULT true keeps every existing user exactly as able as before (they can already edit these fields today); nobody gains access, and an
-- Administrator can now switch it off per user. Administrators are never restricted by this flag (enforced in code, not here).
ALTER TABLE "Account" ADD COLUMN "canEditContactDetails" BOOLEAN NOT NULL DEFAULT true;
