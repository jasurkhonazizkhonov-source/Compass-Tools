-- Cross-booking, cross-event IP capture history ("IP vault") — see
-- IpCapture's own schema doc comment for why this is distinct from the
-- pre-existing Signature.ipAddress column (which stays unchanged). Every
-- signing event (new booking, exchange booking, cancellation confirmation)
-- gets its own row here, encrypted at rest, alongside a deterministic
-- HMAC blind-index (ipHash) so exact-match search never requires
-- decrypting every row.
CREATE TYPE "IpCaptureFormType" AS ENUM ('NEW_BOOKING', 'EXCHANGE_BOOKING', 'CANCELLATION_CONFIRMATION');

CREATE TABLE "IpCapture" (
    "id" TEXT NOT NULL,
    "encryptedIp" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "ipVersion" TEXT NOT NULL,
    "formType" "IpCaptureFormType" NOT NULL,
    "bookingId" TEXT,
    "signerName" TEXT,
    "signerEmail" TEXT,
    "userAgent" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "softDeletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IpCapture_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IpCapture_bookingId_idx" ON "IpCapture"("bookingId");
CREATE INDEX "IpCapture_signerEmail_idx" ON "IpCapture"("signerEmail");
CREATE INDEX "IpCapture_capturedAt_idx" ON "IpCapture"("capturedAt");
CREATE INDEX "IpCapture_ipHash_idx" ON "IpCapture"("ipHash");

ALTER TABLE "IpCapture" ADD CONSTRAINT "IpCapture_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
