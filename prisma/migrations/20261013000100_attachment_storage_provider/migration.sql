-- Lead documents move from Cloudflare R2 to the VPS disk (see docs/LEAD_ATTACHMENTS.md). Files already in R2 must keep working, so the
-- backend becomes an explicit column instead of being guessed from the shape of the key.
--
-- ADDITIVE and non-destructive: one new enum, one new column, one new CHECK constraint. No row is rewritten or removed.
--
--   * Every existing row gets 'R2'. That is true: before this migration the only storage was R2 (rows without a "storageKey" are legacy
--     placeholders that no screen lists or opens).
--   * The column DEFAULT stays 'R2' deliberately. Application code from before this migration does not know the column; if it runs
--     against the migrated database (a rollback, or the window between "migrate" and "deploy") the rows it creates are still R2 rows and
--     are labelled correctly. The new application code always sets the provider explicitly (LOCAL for every new upload).
--   * Adding a NOT NULL column with a constant default is a catalog-only change on PostgreSQL 11+ (no table rewrite, no long lock).
--
-- Safety net: a LOCAL row must carry a well-formed local key ("<2 hex>/<64 hex>"). The application never builds a path from anything
-- else, and the database now refuses to store a LOCAL row whose key could be a path (".." , "/", absolute paths ...).
--
-- Rollback: ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_local_key_format", DROP COLUMN "storageProvider"; DROP TYPE
-- "AttachmentStorageProvider"; - but only AFTER the LOCAL rows have been dealt with (their bytes are on the VPS disk, not in R2).

CREATE TYPE "AttachmentStorageProvider" AS ENUM ('R2', 'LOCAL');

ALTER TABLE "Attachment" ADD COLUMN "storageProvider" "AttachmentStorageProvider" NOT NULL DEFAULT 'R2';

ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_local_key_format"
  CHECK ("storageProvider" <> 'LOCAL' OR ("storageKey" ~ '^[0-9a-f]{2}/[0-9a-f]{64}$' AND substr("storageKey", 1, 2) = substr("storageKey", 4, 2)));
