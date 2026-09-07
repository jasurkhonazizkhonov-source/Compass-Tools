-- Pass 23: additive, nullable timestamp — the atomic first-send claim for
-- sendAirlineConfirmationEmail (same claim-field idiom as
-- Lead.queueDistributedAt / SequenceEnrollment.nextSendAt). No backfill,
-- no data loss, no change to any existing column.
ALTER TABLE "Booking" ADD COLUMN "airlineConfirmationFirstSentAt" TIMESTAMP(3);
