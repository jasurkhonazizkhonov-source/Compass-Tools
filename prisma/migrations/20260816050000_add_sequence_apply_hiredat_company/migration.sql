-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "hiredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SequenceEnrollment" ADD COLUMN     "enrolledById" TEXT;

-- CreateTable
CREATE TABLE "CompanySettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "logoUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanySettings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SequenceEnrollment" ADD CONSTRAINT "SequenceEnrollment_enrolledById_fkey" FOREIGN KEY ("enrolledById") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
