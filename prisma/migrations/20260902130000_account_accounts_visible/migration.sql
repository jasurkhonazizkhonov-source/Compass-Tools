-- Pass 11 Part 1 — Admin-only "visible in Accounts directory" toggle.
-- Purely a directory-visibility preference for the general read-only
-- /accounts page; NOT deletion/deactivation. Defaults to true so every
-- existing account remains visible after this migration (non-breaking,
-- additive column only).
ALTER TABLE "Account" ADD COLUMN "accountsVisible" BOOLEAN NOT NULL DEFAULT true;
