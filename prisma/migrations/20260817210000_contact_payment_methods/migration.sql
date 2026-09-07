-- Contact-level payment methods: a card can now exist on file for a
-- Contact independent of any specific booking (added directly from the
-- Contact page), and a booking-submitted card is now also linked to its
-- Contact so "this customer's payment methods" is one query regardless of
-- how the card was collected.

-- AlterTable
ALTER TABLE "PaymentMethod" ADD COLUMN     "contactId" TEXT,
ALTER COLUMN "bookingId" DROP NOT NULL,
ALTER COLUMN "amountAllocated" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "PaymentMethod_contactId_idx" ON "PaymentMethod"("contactId");

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing booking-submitted payment method is attributed
-- to that booking's own contact, so already-submitted bookings' cards show
-- up on the Contact page too, not just newly-created ones.
UPDATE "PaymentMethod" pm
SET "contactId" = b."contactId"
FROM "Booking" b
WHERE pm."bookingId" = b."id" AND pm."contactId" IS NULL;
