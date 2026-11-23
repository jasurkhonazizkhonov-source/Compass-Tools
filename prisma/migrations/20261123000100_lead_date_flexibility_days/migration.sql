-- The website's flight request form now lets the customer say HOW FAR their dates can move: exact dates, or 1, 2 or 3 days either side. The CRM used to keep only a Boolean
-- ("flexible dates"), which cannot say how flexible. This adds the choice itself, next to the Boolean, which stays exactly as it was (true = flexible, and the website still sends it).
--
-- NULL means "not stated": every lead that exists today, a lead typed in by staff, and a request from an old website bundle that only had the checkbox. 0 means the customer chose exact
-- dates; 1-3 means that many days either side. A CHECK keeps the column honest (NULL or 0-3) whatever writes to it.
--
-- Additive only: one nullable column with no default, so no row is rewritten and no existing value changes (PostgreSQL adds a nullable column without touching the table's rows).
-- Nothing is read, updated or deleted. Deployment order: apply this migration BEFORE the new application image serves traffic (deploy.sh --migrate does that), and deploy the CRM BEFORE the
-- website: the website sends the new field, and the CRM's endpoint is strict (an unknown field is a 400). An old CRM image never sees the column. Rollback: leave the column in place (unused, harmless).
ALTER TABLE "Lead" ADD COLUMN "dateFlexibilityDays" INTEGER;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_dateFlexibilityDays_range" CHECK ("dateFlexibilityDays" IS NULL OR ("dateFlexibilityDays" >= 0 AND "dateFlexibilityDays" <= 3));
