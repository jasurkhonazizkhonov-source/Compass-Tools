-- AlterTable
ALTER TABLE "FlightSegment" ADD COLUMN     "isExtraLeg" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "internalNotes" TEXT,
ADD COLUMN     "netTicketCost" DECIMAL(10,2);
