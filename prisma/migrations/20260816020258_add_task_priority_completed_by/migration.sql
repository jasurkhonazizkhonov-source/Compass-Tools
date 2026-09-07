-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "completedById" TEXT,
ADD COLUMN     "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
