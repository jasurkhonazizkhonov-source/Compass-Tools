-- Pass 23 §32/§33 — closes sendBookingProfitNotification's documented
-- check-then-act race (a plain SELECT for "already sent?" followed later
-- by a plain INSERT, with no atomic claim between them — see
-- booking-notification.ts's own doc comment). Scoped ONLY to the two
-- notification types this function ever writes — BOOKING_CONFIRMATION
-- (sendAirlineConfirmationEmail) intentionally allows multiple SENT rows
-- per booking (legitimate resends), and must not be constrained by this
-- index. A partial unique index (not a full one) so it only ever
-- conflicts on a genuine duplicate SENT row for the same booking+type,
-- never on ordinary FAILED rows or other email types.
CREATE UNIQUE INDEX "EmailLog_booking_notification_sent_unique"
ON "EmailLog" ("bookingId", "type")
WHERE "status" = 'SENT' AND "bookingId" IS NOT NULL AND "type" IN ('BOOKING_PROFIT_NOTIFICATION', 'BOOKING_CANCELLATION_NOTIFICATION');
