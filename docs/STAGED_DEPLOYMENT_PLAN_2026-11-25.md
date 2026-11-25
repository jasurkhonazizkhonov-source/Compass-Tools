# Staged deployment plan: CRM first, website second (2026-11-25)

**Nothing here has been executed.** Every step marked **[APPROVAL]** changes production and needs the owner's explicit approval. Detail lives in the
runbooks named in each step; this file is the order, the gates and the rollback.

## 0. Facts to establish first (read-only)

| Question | How |
|---|---|
| Which CRM commit and image are live? | `docker compose ps`, `docker inspect` image tag, `git log -1` in the deployment directory |
| Which migrations are applied? | `docker compose run --rm tools npx prisma migrate status` |
| Does the live compose file match the repository's? | compare; reconcile **before** `deploy.sh` (an earlier review reported a difference) |
| How does the live website deliver enquiries? | its `.env` names and logs. If it posts to the CRM without a v2 signature, it is refused from step 1 until step 2 |
| Is anything published on the host? Who else is on the tunnel network? | `ss -ltn`, `docker ps`, `docker network inspect` |
| Is a recent backup readable? | `bash deploy/backup-db.sh`, then `bash deploy/restore-db.sh` into its test mode (`DEPLOYMENT.md`) |

Cloudflare, both zones, in the dashboard: DNS records proxied and no record exposing the origin address; tunnel routes; SSL/TLS mode; **Always Use HTTPS on**;
**minimum TLS version 1.2**; HSTS as it is (no `includeSubDomains` or preload without checking every subdomain); Rocket Loader **Off**; no cache rule that
covers dynamic pages or `/api/`; WAF and rate-limit rules (note what exists); security events. Each setting change is an **[APPROVAL]** item.

## 1. CRM

1. **Release**: the exact commit of `release/compass-tools-2026-11-22` with every CI job green.
2. **Migrations**: this branch has 12 that `origin/main` does not (what production has applied is unknown: read `migrate status`). Apply all that are
   listed, in order; all are forward-only. 85 applied cleanly to an empty PostgreSQL 17.11 with no drift against `schema.prisma`.

   | Migration | What it does | Older application against it |
   |---|---|---|
   | `20261108000100_sign_in_location_provenance` | new `Account` column(s) for the sign-in location source | works |
   | `20261113000100_inquiry_submission_info` | new table `InquirySubmissionInfo` | works |
   | `20261115000100_account_contact_detail_edit_permission` | `Account.canEditContactDetails`, default true | works |
   | `20261120000100_security_privacy_marketing_scale` | new enum values, columns, tables (failed sign-ins, email reveals, imports, templates), indexes | new enum values must not have been written before a rollback |
   | `20261122000100_account_contact_detail_edit_default_off` | default becomes false for new rows | works |
   | `20261122000200_marketing_send_cancelled_status` | enum value `CANCELLED` | same enum note |
   | `20261123000100_lead_date_flexibility_days` | nullable `Lead.dateFlexibilityDays` with a 0-3 check | works |
   | `20261124000100_sequence_reply_stop_and_scheduling` | enum value `REPLIED`, new nullable columns, `SequenceReply` table, indexes | works; the new enum value must not have been written before a rollback |
   | `20261124000200_sequence_step_body_format` | `SequenceStep.bodyFormat`, default `TEXT` | works |
   | `20261125000100_sequence_enrollment_contact_subject` | `contactId` (backfilled, then required), `leadId` optional, FK, indexes | works for lead enrollments; **contact-only rows break the older sender** (`rollback.sh` refuses while any is active or failed) |
   | `20261125000200_campaign_send_quota_indexes` | two indexes | works |
   | `20261125000300_sequence_enrollment_contact_fill_trigger` | fills `contactId` for inserts that omit it | required for an older image to keep enrolling |

3. **Backup** and restore check (section 0). Rehearsal of the scripts without Docker: `deploy/rehearsal/restore-rehearsal.sh`.
4. **Configuration** (`.env`, names only): the required values in `compose.yaml`; `LEAD_INGEST_SECRET` (new random value, 32+ characters);
   **`WEBSITE_SIGNATURE_REQUIRED=true`**; `WEBSITE_API_KEY`, `WEBSITE_API_COMPANY_ID`; `TRUSTED_PROXY=cloudflare` is fixed by `compose.yaml`.
5. **[APPROVAL]** `bash deploy/deploy.sh --release-branch release/compass-tools-2026-11-22 --ref <full commit> --migrate`. It stops before any change if the
   signing configuration is unsafe, takes a backup before migrating, and ends with `verify.sh`.
6. **[APPROVAL]** Install the daily maintenance timer (`deploy/systemd/compass-tools-maintenance.timer`). Without it expired rate-limit counters (which hold
   client addresses as keys) are never deleted and abandoned uploads are not swept.
7. **Gates before the website**: `verify.sh` passes with `schema=current` and `websiteSignature=required`; System Health has no Critical row; an unsigned
   `POST /api/public/subscribe` from the private network answers 401; clocks synchronised.

Rate limiting after this step: public routes per connecting client (`CF-Connecting-IP`; an IPv6 client counted by its /64), website traffic per signed visitor
in shared PostgreSQL counters, the flight API additionally 120 per minute for the whole website. Counters survive restarts.

## 2. Website (only after every gate of step 1)

1. **Release**: the exact commit of `review/website-parity-and-contact-ip-2026-11-15` with CI green.
2. `.env`: `CRM_API_URL` (the name that really resolves), `CRM_API_KEY` (= `WEBSITE_API_KEY`), `CRM_COMPANY_ID` (= `WEBSITE_API_COMPANY_ID`),
   `LEAD_INGEST_SECRET` (= the CRM's), the mail variables. Leave `EDGE_PROOF_SECRET` and `EDGE_PROOF_MODE` empty for this step.
3. `deploy/preflight.sh`, then **[APPROVAL]** `deploy/deploy.sh` (website repository, `docs/WEBSITE_VPS_DEPLOYMENT_AND_ROLLBACK_RUNBOOK.md`).
4. **[APPROVAL]** one marked test flight request, contact message and newsletter sign-up: each arrives once, the enquiry shows the visitor IP and location,
   no `[website-signature] refused:` line. Delete the test records.
5. Failure behaviour (do not stop the production CRM to test it; it was tested in isolation): the visitor sees a generic message and keeps the typed form.

## 3. Edge proof (separate, later, optional until the isolation facts are confirmed)

Website repository, `docs/EDGE_PROOF_ACTIVATION_RUNBOOK.md`: **[APPROVAL]** create the Cloudflare rule, set the secret with `EDGE_PROOF_MODE=observe`, verify
with `deploy/check-edge-proof.sh` and a day of logs, then **[APPROVAL]** `enforce`.

## 4. Monitoring after each step

`/api/health` on both (200); CRM System Health; logs: `[website-signature]`, `[website-api]` (CRM), `[crm-api]`, `[submitFlightRequest]`,
`[submitContactMessage]`, `[rate-limit]`, `[edge-proof]` (website). A run of `refused: expired|future` is clock drift; `bad_signature` is a secret or company
mismatch; `no signature` is a caller that does not sign.

## 5. Rollback (never run against production without approval)

| What | How | Data effect |
|---|---|---|
| Website image | `deploy/rollback.sh previous` in the website directory; the old database-backed release needs its own compose and `.env` | none |
| CRM image | `bash deploy/rollback.sh <version>`; read its contact-only refusal | none; migrations stay |
| Migrations | not reversed in place. Restore the pre-deploy backup only if the old image cannot run on the new schema (`restore-db.sh --replace`) | loses writes since the backup |
| API settings | restore the previous `.env` values, recreate that one container | none |
| Signing | there is no unsigned switch on the new CRM. Fix the secret, company id or clock. Keep `WEBSITE_SIGNATURE_REQUIRED=true` on an older image | none |
| Edge proof | `EDGE_PROOF_MODE=observe`, or empty both variables; the Cloudflare rule may stay | none |
| Cloudflare rules | disable the single rule changed, in reverse order | none |
| Containers | recreate only the affected service; never `down -v`, never prune | none |
| Health | `deploy/verify.sh` in the affected directory after every rollback | |
