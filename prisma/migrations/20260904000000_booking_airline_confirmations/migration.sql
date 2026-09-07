-- Pass 23: additive, nullable JSON column — no backfill, no data loss,
-- no change to any existing column. Existing bookings simply have NULL
-- here until next saved; resolveAirlineConfirmations() synthesizes a
-- one-entry fallback from the legacy airlineConfirmationNumber/
-- ticketNumbers columns whenever this is NULL.
ALTER TABLE "Booking" ADD COLUMN "airlineConfirmations" JSONB;
