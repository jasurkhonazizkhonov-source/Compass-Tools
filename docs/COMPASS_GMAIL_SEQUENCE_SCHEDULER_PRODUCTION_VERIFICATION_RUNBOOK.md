# Gmail / Sequence / Scheduler - Production Verification Runbook

For an **authorized operator after an approved deployment**. Nothing in this document was executed by the author; it describes checks that need a live deployment, a real PostgreSQL, a real Google OAuth client and a real Gmail account. Use **test accounts and test leads only** (a lead whose email is a mailbox you control). Never paste tokens, secrets or customer data into tickets or chat. `$CRON_SECRET` below means "read it inside the container; do not echo it".

Legend: [L] can be rehearsed locally with mocks (already done by the test suite) - [P] requires the approved deployment.

## 0. Before deploying (approvals, backups)

1. Written approval for: the deploy, running migrations (`deploy/deploy.sh --migrate`), and the optional delivery-state migration (readiness report section 2).
2. `bash deploy/backup-db.sh` and confirm a new verified backup file exists; note its name. Restore procedure rehearsed once on a **disposable** database (`deploy/restore-db.sh` into a scratch DB, never production).
3. Rehearse the pending migrations on a disposable PostgreSQL: `prisma migrate status`, then apply, then `bash deploy/check-migration-drift.sh`. Run the 1,099 database-gated tests there (`INTEGRATION_DATABASE_URL` pointing at the disposable server; the safety guard must accept it - do not weaken it).
4. Confirm the Compose file used for the deploy matches the live stack (the live-vs-git difference noted in earlier reports).

## 1. Gmail OAuth and token refresh [P]

1. Google Cloud Console: the OAuth client's **Authorized redirect URI** equals `https://<crm-host>/api/auth/gmail/callback` exactly (copy it from the server log line `[gmail-connect] START` - it prints the redirect URI, no secret).
2. Environment (names only): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY` (32 bytes, base64) present; System Health -> "Gmail sending" shows the key as Configured.
3. As a test agent open a **test lead** (assigned to that agent, contact email = a mailbox you control) -> Apply Sequence. Expected: the Gmail notification "Gmail is not connected" (agent not yet connected), **no enrollment created** (lead page shows no active sequence; sequence page lists nothing).
4. Click **Connect Gmail** in the notification. Expected: Google consent asks only for sending and identity; after approving you land **back on the same lead** with a "connected" toast. If you land on the dashboard instead, the return cookie was lost - record it.
5. Revocation: in the test Google account's security page remove the app's access; re-open the lead -> Apply Sequence. Expected: "Gmail needs to be reconnected" (not "not connected"). Reconnect.
6. Scope: a connection without the send permission shows "Gmail cannot send email".
7. Wrong user: connecting with a Google account whose email differs from the CRM login email must end with the "mismatch" toast and store nothing.

## 2. Actual delivery and Sent-folder reconciliation [P]

1. Use a one-step sequence (delay 0) named `VERIFY - do not use`, whose body is plain test text. Lead = the test lead.
2. Apply Sequence -> confirmation shows "Sent from your Gmail to <test mailbox>" -> **Approve and Start**. Expected: toast "first email was sent"; the lead card shows Active/Completed with "Last sent: step 1 (time)".
3. Check **both**: the test mailbox received exactly **one** message; the agent's Gmail **Sent** folder contains exactly one. Compare the time with the lead card.
4. Database check (read-only, on the production DB by an authorized DBA): the lead's `SequenceStepLog` has one row `status = 'SENT'` with a `sentAt`, no leftover `IN_FLIGHT:`/`UNCERTAIN:` row; `EmailLog` has one SENT row with a `messageId`.
5. Click Approve twice quickly on a fresh lead (double click): still exactly one email and one enrollment.

## 3. Scheduler health and automatic processing [P]

1. After start, within about two minutes: `docker compose exec app node -e` calling `/api/health` with the bearer (read inside the container) must show `readiness.sequenceScheduler = "running"`. Also open **System Health -> "Automatic sequence sending"**: state Healthy, "Automatic sending operational: Yes", a last successful run time.
2. Create a **two-step** test sequence (step 1 delay 0, step 2 delay 5 minutes). Start it for the test lead. Expected: step 1 immediately; at about +5 minutes (within the one-minute tick) step 2 arrives **without anyone opening a page**; the sequence page shows both steps Sent and the enrollment Completed.
3. Overlap: watch the log for `[sequence-sender]`; there must be no repeated "stalled" state and no two sends of the same step.
4. Restart recovery: start a two-step sequence with step 2 delay 10 minutes, `docker compose restart app` at minute 3, confirm step 2 still arrives once at about minute 10.
5. Disabled mode (only on a non-production or maintenance window): `DISABLE_IN_PROCESS_POLLER=true` -> System Health shows "Disabled" (warning) and sequence mail stops unless `deploy/run-sequence-sweep.sh` / the systemd timer calls the sweep every minute.
6. **Multiple instances**: this design has no coordination between instances except the row-level claim. If more than one app instance will ever run, run steps 3-4 with two instances against the disposable PostgreSQL first and confirm each step is sent once (a test not available locally). Until demonstrated, run **one** app instance.

## 4. Unknown-outcome recovery [P, needs a fault]

You cannot safely force a real Gmail timeout in production. Rehearse on staging with a network rule that drops the connection to `gmail.googleapis.com` after the request leaves, or accept that this path is verified only by the mocked tests. If it occurs naturally: the lead card shows **Delivery unconfirmed**; open the sender's Gmail Sent folder; choose **It was sent** (the step is recorded, the sequence continues) or **Send again** (read the duplicate warning). Verify the `Activity` entries `SEQUENCE_DELIVERY_UNCERTAIN` and `SEQUENCE_DELIVERY_CONFIRMED`/`SEQUENCE_DELIVERY_RESENT` name the person.

## 5. Retry behaviour [P]

1. Temporarily revoke Gmail for the test agent *after* an enrollment exists, wait for the next step: the enrollment ends **Failed** with the reason and the lead history shows **Retry**. Reconnect Gmail, press **Retry**: the **same** enrollment continues; no second enrollment appears.
2. Temporary provider failure cannot be forced safely; rely on the mocked tests, and watch for "Retry scheduled" in real traffic.

## 6. Database integrity [P]

After the tests above (read-only queries by a DBA): no enrollment with `status='ACTIVE'` and `nextSendAt` in the far past; no `SequenceStepLog` rows with `error LIKE 'IN_FLIGHT:%'` older than 5 minutes; no step with two `SENT` rows; `prisma migrate status` clean; `SELECT count(*) FROM "Account" WHERE "canEditContactDetails" IS NOT TRUE` as expected for the contact-permission migration.

## 7. Permissions [P]

As a restricted test user (no phone/email permission): the lead/contact phone and email controls are absent and a direct edit attempt is refused. As an agent who is **not** the lead's owner: Retry / Send again / It was sent / Unenroll on that lead are refused ("not found"). As an Administrator of company A: another company's lead is never visible.

## 8. Logs and health checks

Look for: `[sequence-sender]` (category-only errors), `[gmail-send]` lines (never contain tokens), no full email addresses and no token strings (grep the last hour of logs for `ya29.`, `1//`, `refresh_token`; expected none). `/api/health` anonymous answer is only `{status}`.

## 9. Rollback and incident response

- **Stop automatic sending quickly**: set `DISABLE_IN_PROCESS_POLLER=true` and restart the app container (or switch the sequence(s) to Inactive from the Sequences page: that pauses sending without losing state).
- **Bad deploy**: `bash deploy/rollback.sh` returns to the previous image; if a migration must be undone, restore the verified backup (forward-only migrations are not reversed in place).
- **Duplicate email reported**: pull the lead's `SequenceStepLog` rows and `EmailLog` for the step; check for a `RESOLVED:` row (a person chose "Send again") before treating it as a defect; open an incident with the log lines and the enrollment id (no email content).
- **Stalled scheduler**: System Health shows Stalled with an error category; check database reachability first; recovery is automatic on the next successful run.

## 10. Reply detection with a REAL mailbox (the one check no automated test can make) [P]

**Status: not performed.** Every reply test so far uses a scripted mailbox. Do not call reply detection production-ready until this section has been completed once on the real deployment.

Safety rules: use a **dedicated sending mailbox** (a CRM account created for the test, with its own Gmail connected) and **test recipients you own** (two throw-away mailboxes: "Recipient A", "Recipient B"). Never a real customer, never a real campaign list. Nothing here needs production data, a production secret or a schema change.

1. **Prerequisites.** The sending account's Gmail was (re)connected **after** the release that adds the `gmail.metadata` permission (older connections hold only `gmail.send`); System Health > "Reply detection" shows that mailbox under "can detect replies". The Google OAuth consent screen lists `gmail.metadata`; while the app is in Testing, the sender and both recipients' Google accounts are listed as test users, otherwise Google verification of the restricted scope is required first (docs/DEPLOYMENT.md 2c).
2. **Set up.** A two-step sequence (step 2 after 1 day or more) and two contacts - one **without a lead** (contact-only) and one **with a lead** - each with a recipient address you own; enroll both. Check each enrollment shows Active and the first email arrives from the dedicated mailbox.
3. **A genuine reply stops the right enrollment.** Reply from Recipient A to the first email, with some text. Within about two minutes (one poller pass; or call `GET /api/cron/sequence-replies` with the bearer secret) the enrollment of A shows *Replied - automatically stopped*, the Activity entry "The customer replied..." appears on the contact/lead, and step 2 is cancelled. B is still Active.
4. **Unrelated messages stop nothing.** From a third address send the dedicated mailbox a **new** message (a different conversation); B's enrollment must stay Active. Forward nothing.
5. **Automatic replies and bounces do not count.** Turn on an out-of-office (vacation) auto-reply in Recipient B's mailbox, so it answers the sequence email by itself: that auto-reply arrives in the conversation, and B must stay Active. Then enroll a contact with a deliberately non-existent address at a real domain you control: the bounce notice must not stop anything and must not be recorded as a reply.
6. **Idempotent and no duplicates.** Wait for two more poller passes: the reply count on A stays 1, no second Activity entry, no second audit entry (`SEQUENCE_STOPPED_BY_REPLY`).
7. **Evidence to keep:** the enrollment rows (status, stopReason, stoppedAt), the single `SequenceReply` row, the audit entry, System Health's reply-detection panel, and the absence of message bodies/subjects in the logs (grep the last hour of logs for the test subject: no match).
8. Remove the test enrollments, contacts and the dedicated account afterwards.

Nothing in this runbook authorizes production changes; each section needs the operator's own change approval.
