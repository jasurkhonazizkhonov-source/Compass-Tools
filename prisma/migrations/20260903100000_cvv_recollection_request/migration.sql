-- CVV recollection follow-up: a public, single-use, short-lived REQUEST
-- record for asking the customer to re-submit their CVV at actual charge
-- time (the PCI-compliant alternative to extending CVV cache retention —
-- see src/server/security/cvv-cache.ts's own header comment). No CVV
-- value is ever stored in this table or anywhere else in the schema.
CREATE TABLE "CvvRecollectionRequest" (
    "id" TEXT NOT NULL,
    "paymentMethodId" TEXT NOT NULL,
    "requestedById" TEXT,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CvvRecollectionRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CvvRecollectionRequest_token_key" ON "CvvRecollectionRequest"("token");
CREATE INDEX "CvvRecollectionRequest_paymentMethodId_idx" ON "CvvRecollectionRequest"("paymentMethodId");

ALTER TABLE "CvvRecollectionRequest" ADD CONSTRAINT "CvvRecollectionRequest_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CvvRecollectionRequest" ADD CONSTRAINT "CvvRecollectionRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
