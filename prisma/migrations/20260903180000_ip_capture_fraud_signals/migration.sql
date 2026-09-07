-- IP vault fraud-detection follow-up: internal-only signals (no external
-- IP-reputation/geolocation API involved) — see ip-risk.ts for the exact,
-- documented risk-scoring arithmetic.
ALTER TABLE "IpCapture" ADD COLUMN "subnetHash" TEXT;
ALTER TABLE "IpCapture" ADD COLUMN "riskScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "IpCapture" ADD COLUMN "suspicious" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "IpCapture" ADD COLUMN "notes" TEXT;

CREATE INDEX "IpCapture_subnetHash_idx" ON "IpCapture"("subnetHash");
CREATE INDEX "IpCapture_suspicious_idx" ON "IpCapture"("suspicious");
