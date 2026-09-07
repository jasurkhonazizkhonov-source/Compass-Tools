-- Pass 24: additive, nullable column — records which version of the legal
-- content (src/lib/legal-content.ts's LEGAL_CONTENT_VERSION) a customer
-- accepted at signing time. Existing bookings get NULL (genuine, honest
-- historical data — never backfilled with a fabricated version). No data
-- loss, no rewrite of any existing column.
ALTER TABLE "Booking" ADD COLUMN "termsVersion" TEXT;
