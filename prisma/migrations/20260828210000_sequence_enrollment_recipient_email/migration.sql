-- Part 4: the email address(es) a sequence enrollment's automated sends go
-- to, explicitly chosen at enroll time when the contact has more than one
-- email on file. Nullable — null means "use the contact's primary email
-- at send time", the pre-existing behavior.
ALTER TABLE "SequenceEnrollment" ADD COLUMN "recipientEmail" TEXT;
