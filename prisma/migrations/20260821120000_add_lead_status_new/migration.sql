-- Adds a NEW lead status, distinct from ATTEMPTING_TO_CONTACT (the default
-- for every other lead-creation path) and from ACCEPTED (which already
-- means "auto-assigned to an existing contact's owner at creation time" —
-- see the Lead.status doc comment). NEW is set only by acceptLeadOffer when
-- a fresh website lead is accepted through the 60-second queue offer.
-- Purely additive — existing rows keep whatever status they already have.
ALTER TYPE "LeadStatus" ADD VALUE 'NEW';
