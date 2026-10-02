-- Multi-city travel requests: the ordered legs of a lead. Additive only — a new
-- table, its indexes and foreign keys. Existing leads (one-way, round-trip and
-- the single route of any older multi-city lead) are untouched and keep using
-- the departure/arrival/date columns on "Lead".
CREATE TABLE "LeadSegment" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "departureAirportId" INTEGER,
    "arrivalAirportId" INTEGER,
    "departureDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSegment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeadSegment_leadId_sequence_idx" ON "LeadSegment"("leadId", "sequence");

ALTER TABLE "LeadSegment" ADD CONSTRAINT "LeadSegment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeadSegment" ADD CONSTRAINT "LeadSegment_departureAirportId_fkey" FOREIGN KEY ("departureAirportId") REFERENCES "Airport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LeadSegment" ADD CONSTRAINT "LeadSegment_arrivalAirportId_fkey" FOREIGN KEY ("arrivalAirportId") REFERENCES "Airport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
