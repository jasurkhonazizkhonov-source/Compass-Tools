-- Pass 6 — the Contact detail page's own Email composer needs its own
-- EmailType so a Contact-originated one-off email is distinguishable from
-- one sent through a specific Lead (LEAD_EMAIL) or a Get in Touch inquiry
-- (INQUIRY_EMAIL) — same precedent, additive only.
ALTER TYPE "EmailType" ADD VALUE 'CONTACT_EMAIL';
