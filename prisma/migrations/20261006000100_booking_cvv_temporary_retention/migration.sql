-- Temporary, encrypted retention of the security code (CVV/CVC) a customer submitted with ONE card on the Booking Form, so an
-- Administrator can charge that card by hand. ADDITIVE: one new table; no existing table, column, row or constraint is changed.
-- The value is held ONLY as a card-vault envelope - never plaintext - and the row can never outlive 24 hours after the form was
-- signed: the database itself pins expiresAt to signedAt + 24 hours. The application clears the value (sets it to NULL) when the
-- payment is recorded as successfully charged/confirmed, when an Administrator destroys it, when the card's payment workflow is cancelled, or at expiry (daily cron + a check
-- before every reveal). See docs/CARD_VAULT_SECURITY.md section 19.
--
-- Rollback: DROP TABLE "PaymentMethodCvv"; (nothing else references it; the table only ever holds short-lived ciphertext).
CREATE TABLE "PaymentMethodCvv" (
    "paymentMethodId" TEXT NOT NULL,
    "encryptedCvv" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "destroyedAt" TIMESTAMP(3),
    "destroyedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMethodCvv_pkey" PRIMARY KEY ("paymentMethodId")
);

CREATE INDEX "PaymentMethodCvv_expiresAt_idx" ON "PaymentMethodCvv"("expiresAt");

ALTER TABLE "PaymentMethodCvv" ADD CONSTRAINT "PaymentMethodCvv_paymentMethodId_fkey"
  FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only NULL (destroyed) or a card-vault envelope can be stored: a plaintext code is rejected by the database itself.
ALTER TABLE "PaymentMethodCvv" ADD CONSTRAINT "PaymentMethodCvv_encryptedCvv_envelope"
  CHECK ("encryptedCvv" IS NULL OR "encryptedCvv" ~ '^cv2\.[A-Za-z0-9]{1,12}\.[A-Za-z0-9_-]{20,}$');

-- The retention window is exactly 24 hours from signing; no longer window can be written, by any code path.
ALTER TABLE "PaymentMethodCvv" ADD CONSTRAINT "PaymentMethodCvv_expires_24h_after_signing"
  CHECK ("expiresAt" = "signedAt" + INTERVAL '24 hours');

-- A destroyed row never holds ciphertext, and a live row never claims to be destroyed.
ALTER TABLE "PaymentMethodCvv" ADD CONSTRAINT "PaymentMethodCvv_destroyed_consistent"
  CHECK (("encryptedCvv" IS NULL AND "destroyedAt" IS NOT NULL) OR ("encryptedCvv" IS NOT NULL AND "destroyedAt" IS NULL));
