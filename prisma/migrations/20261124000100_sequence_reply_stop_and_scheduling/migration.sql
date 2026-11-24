-- Sequence automation: automatic stop when the customer replies, a recorded reason for every stop, per-email Gmail ids, and the data the fair/quota-aware sender needs.
--
-- ADDITIVE ONLY. One new enum label, new nullable columns, one new table, new indexes. No row is read, rewritten or deleted; no existing status changes meaning; every
-- historical enrollment, step log, activity and email record is untouched. Rows that stopped before this migration keep their status and have NULL stop fields.
--
-- Deployment order: apply BEFORE the new application image serves (deploy.sh --migrate does that). An older image ignores the new columns and never writes REPLIED.
-- Rollback: the application can be rolled back without undoing this (the label and columns are simply unused). PostgreSQL cannot remove an enum label.

ALTER TYPE "EnrollmentStatus" ADD VALUE IF NOT EXISTS 'REPLIED';

-- Why an enrollment stopped, who and when; why a due step is waiting.
ALTER TABLE "SequenceEnrollment"
  ADD COLUMN "stopReason"  TEXT,
  ADD COLUMN "stoppedAt"   TIMESTAMP(3),
  ADD COLUMN "stoppedById" TEXT,
  ADD COLUMN "waitReason"  TEXT;

CREATE INDEX "SequenceEnrollment_status_currentStepIdx_nextSendAt_idx" ON "SequenceEnrollment"("status", "currentStepIdx", "nextSendAt");

-- What each sent email was and where it lives in Gmail (so a reply can be matched to it).
ALTER TABLE "SequenceStepLog"
  ADD COLUMN "senderAccountId" TEXT,
  ADD COLUMN "toEmail"         TEXT,
  ADD COLUMN "gmailMessageId"  TEXT,
  ADD COLUMN "gmailThreadId"   TEXT,
  ADD COLUMN "repliesCheckedAt" TIMESTAMP(3);

CREATE INDEX "SequenceStepLog_gmailThreadId_idx" ON "SequenceStepLog"("gmailThreadId");
CREATE INDEX "SequenceStepLog_senderAccountId_createdAt_idx" ON "SequenceStepLog"("senderAccountId", "createdAt");
CREATE INDEX "SequenceStepLog_senderAccountId_repliesCheckedAt_idx" ON "SequenceStepLog"("senderAccountId", "repliesCheckedAt");

-- One row per customer reply found. The unique key makes a repeated finding a no-op.
CREATE TABLE "SequenceReply" (
  "id"                TEXT         NOT NULL,
  "enrollmentId"      TEXT         NOT NULL,
  "stepLogId"         TEXT,
  "gmailConnectionId" TEXT         NOT NULL,
  "gmailMessageId"    TEXT         NOT NULL,
  "gmailThreadId"     TEXT         NOT NULL,
  "fromEmail"         TEXT         NOT NULL,
  "receivedAt"        TIMESTAMP(3) NOT NULL,
  "stoppedEnrollment" BOOLEAN      NOT NULL DEFAULT false,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SequenceReply_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SequenceReply_gmailConnectionId_gmailMessageId_key" ON "SequenceReply"("gmailConnectionId", "gmailMessageId");
CREATE INDEX "SequenceReply_enrollmentId_idx" ON "SequenceReply"("enrollmentId");

ALTER TABLE "SequenceReply" ADD CONSTRAINT "SequenceReply_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "SequenceEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reply detection cursor and the provider "slow down" window of one mailbox.
ALTER TABLE "GmailConnection"
  ADD COLUMN "historyId"        TEXT,
  ADD COLUMN "inboundCheckedAt" TIMESTAMP(3),
  ADD COLUMN "inboundError"     TEXT,
  ADD COLUMN "sendBlockedUntil" TIMESTAMP(3);
