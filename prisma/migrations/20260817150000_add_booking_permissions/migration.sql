-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "bookingPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[];
