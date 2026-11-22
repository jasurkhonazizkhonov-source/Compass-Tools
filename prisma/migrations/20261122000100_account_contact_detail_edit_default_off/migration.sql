-- New accounts are NOT allowed to edit Lead/Contact phone numbers and email addresses unless an Administrator switches the permission on.
-- Only the DEFAULT used for rows inserted from now on changes. SET DEFAULT never rewrites a row that already exists, so every existing account - the ones that were
-- switched on, the ones that were switched off, and every administrator - keeps exactly the value it has today. No data is read, updated or deleted.
-- An Administrator is never restricted by this flag (enforced in code); administrators created through the CRM's own workflows are stored with the flag ON explicitly.
ALTER TABLE "Account" ALTER COLUMN "canEditContactDetails" SET DEFAULT false;
