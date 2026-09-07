-- Account.tipPercent: admin-set tip percentage, same shape/precedent as
-- commissionPercent — used by the Commission Summary's Tip Earnings line.
ALTER TABLE "Account" ADD COLUMN "tipPercent" DECIMAL(5,2);

-- Booking.internalNotes: free-text internal ticketing notes, never
-- customer-facing (same isolation guarantee as pnr).
ALTER TABLE "Booking" ADD COLUMN "internalNotes" TEXT;

-- Notification.contactInquiryId: click-through target for a "New Get in
-- Touch Message" notification, same pattern as taskId/leadId/quoteId.
ALTER TABLE "Notification" ADD COLUMN "contactInquiryId" TEXT;
CREATE INDEX "Notification_contactInquiryId_idx" ON "Notification"("contactInquiryId");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_contactInquiryId_fkey" FOREIGN KEY ("contactInquiryId") REFERENCES "ContactInquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
