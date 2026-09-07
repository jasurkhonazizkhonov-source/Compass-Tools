-- Part 2: a one-off, agent-authored email sent from the Leads page's new
-- Email button gets its own EmailLog type, distinct from every other
-- (all template-generated) EmailType value.
ALTER TYPE "EmailType" ADD VALUE 'LEAD_EMAIL';
