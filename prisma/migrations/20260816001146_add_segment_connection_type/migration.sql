-- CreateEnum
CREATE TYPE "SegmentConnectionType" AS ENUM ('LAYOVER', 'MULTI_CITY');

-- AlterTable
ALTER TABLE "FlightSegment" ADD COLUMN     "connectionType" "SegmentConnectionType";
