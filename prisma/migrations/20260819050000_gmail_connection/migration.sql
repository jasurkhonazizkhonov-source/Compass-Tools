-- CreateEnum
CREATE TYPE "GmailConnectionStatus" AS ENUM ('CONNECTED', 'REVOKED');

-- CreateTable
CREATE TABLE "GmailConnection" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "googleEmail" TEXT NOT NULL,
    "scopes" TEXT[],
    "encryptedRefreshToken" TEXT NOT NULL,
    "status" "GmailConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GmailConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailConnection_accountId_key" ON "GmailConnection"("accountId");

-- CreateIndex
CREATE INDEX "GmailConnection_status_idx" ON "GmailConnection"("status");

-- AddForeignKey
ALTER TABLE "GmailConnection" ADD CONSTRAINT "GmailConnection_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
