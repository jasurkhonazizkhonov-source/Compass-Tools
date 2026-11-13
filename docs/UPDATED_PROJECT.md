# Compass Tools — the updated CRM checkout (`compass-tools-updated`, port 3001)

This repository is the **updated** Compass Tools CRM. It is independent of the original CRM checkout (`compass-tools`, port 3000):
it has its own `.git`, its own `package.json` + lockfile, its own `node_modules`, and reads nothing from any other folder.

| | Original | Updated (this repository) |
|---|---|---|
| Folder | `F:\Claude Workspace\compass-tools` | `F:\Claude Workspace\compass-tools-updated` |
| Dev port | 3000 | **3001** (`npm run dev` = `next dev -p 3001`) |

All new CRM development goes here. The original is left as it is.

## Setup

```bash
npm ci                      # exact versions from package-lock.json; runs `prisma generate`
cp .env.example .env        # then fill in values - never commit .env
npx prisma migrate deploy   # against YOUR database (a local/scratch one for development)
npm run dev                 # http://localhost:3001
```

Minimum for a local run: `DATABASE_URL`, `GOOGLE_CLIENT_ID` (a placeholder is enough to render pages; real sign-in needs a real OAuth client that
lists `http://localhost:3001` as an authorised origin, see `docs/DEPLOYMENT.md`), `GMAIL_TOKEN_ENCRYPTION_KEY`, `CARD_ENCRYPTION_KEY`,
`IP_ENCRYPTION_KEY`, `IP_HASH_KEY`. Every variable is explained in `.env.example`. **Never point a development checkout at a production database.**

## Checks

```bash
npx tsc --noEmit
npx eslint
npm run build
npx vitest run --maxWorkers=3
```

The real-database integration suites are skipped unless you provide a **disposable** PostgreSQL database that already has the migrations applied:

```bash
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/scratch npx prisma migrate deploy
INTEGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/scratch \
INTEGRATION_ADMIN_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres \
  npx vitest run --maxWorkers=3
```

Test safety: `src/server/queries/__tests__/reference-data.test.ts` reads the seeded reference tables and inserts/deletes one airline row. It used to load `.env`\nthrough `dotenv/config` and use any ambient `DATABASE_URL`, so a plain `npm test` could write to whatever database `.env` pointed at. It now follows the same rule\nas every `*.integration.test.ts`: it runs only when `INTEGRATION_DATABASE_URL` points at a disposable PostgreSQL (migrations applied) and is skipped otherwise, so no\nordinary test run can touch a live database. (The original CRM folder holds an unfinished, stricter `src/test/disposable-database.ts` gate - loopback host and the exact\ndatabase name `compass_test` - that was never committed; adopting it is a separate decision.)\n\nKnown and pre-existing: `prisma migrate diff` reports that `PaymentChargeStatus` has two more values in the migrations (`REFUNDED`,
`PARTIALLY_REFUNDED`) than `schema.prisma`. PostgreSQL enum values are never dropped, so this is intentional, not drift introduced here.

## Features in this checkout

* **CRM UI improvements** — Commissions/Salesboard without the previous-period comparison, a calendar popover for the Commissions custom
  range, two-line note author/timestamp in lead, contact and inquiry notes, "View full profile" opening in a new tab, and a development-only
  CSP allowance (`'unsafe-eval'` for `next dev`; production policy unchanged).
* **Last sign-in location** — Vercel-independent local IP geolocation (`src/server/geo/*`, `docs/GEOIP.md`, migration
  `20261108000100_sign_in_location_provenance`, `npm run geoip:*`).
* **Bulk selection / bulk actions on Leads and Contacts** — checkbox selection, Add-to-sequence, Admin-only bulk delete
  (`src/lib/bulk-selection.ts`, `src/server/actions/bulk-selection.ts`, `src/components/crm/bulk-*`).
* **Website lead API** — `POST /api/v1/website/flight-inquiries` (`docs/WEBSITE_LEAD_API.md`) with the idempotency key + request fingerprint
  (`LeadIngestFingerprint`, migration `20261016000100_lead_ingest_fingerprint`).
* **Local upload storage** — Lead documents live on the server's disk (`UPLOAD_STORAGE_DIR`, `docs/LEAD_ATTACHMENTS.md`); Cloudflare R2 is gone.
* **Self-hosted deployment** — `Dockerfile`, `compose.yaml`, `deploy/`, CI and `docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md` (Docker Compose,
  Cloudflare Tunnel, private website-API network, backups). These were written on the branches below and proven by their CI smoke test; they
  have **not** been run from this machine.

## Where the IP-geolocation database lives (`city.mmdb`)

The licensed third-party database is **never committed** (`*.mmdb` and `/data/geoip/` are git-ignored). The runtime location is:

* default: `data/geoip/city.mmdb` under the application's working directory, or
* any absolute path set in `GEOIP_DB_PATH`.

Install or replace it with the validating, atomic installer: `npm run geoip:install -- /path/to/city.mmdb` (the previous file is kept as
`city.mmdb.previous`). `npm run geoip:verify` checks it. On the development machine the working copy that was recovered with the earlier
geolocation work is kept in `compass-tools-recovery\work\geo-data\city.mmdb` as a backup source; nothing at runtime reads from there.
Details, licence/attribution and update policy: `docs/GEOIP.md`.

## Archived material

* `docs/requirements/full_spec.txt` - the original UI / quote / itinerary / booking / email / sequence / task requirements brief.
* `docs/recovery-archive/` - reports and small data files about the 2026-10 loss of the CRM working tree and the recovery investigation
  (see the README there). The raw Claude Code transcripts stay under `C:\Users\Hp\.claude\projects\`.

## Provenance of this working tree (2026-11-09)

Base `5a77976` (= `origin/main`, PR #1). Combined, **uncommitted**, in this order:

1. A pending (not yet committed) merge of `github/feature/website-api-idempotency-fingerprint` (`c6b8d8e`). That branch already contains
   `feature/website-lead-api` (`4d33c29`) which contains `feature/local-upload-storage` (`b23eaf1`) and the VPS/Docker baseline (`572d40b`);
   `MERGE_HEAD` is set, so committing creates a real merge commit and keeps all of that history.
2. The geolocation work (previously uncommitted in a separate clone, based on `5a77976`) and the bulk-actions work (same), each merged
   file-by-file with a three-way merge against `5a77976`.
3. The CRM UI changes (17 files) that were already uncommitted here.

Conflict resolutions: `README.md`, `docs/WEBSITE_LEAD_API.md` and `src/__tests__/website-api-guards.test.ts` took the branch side (it is the
later, superset version of the same documents/tests). `prisma/schema.prisma` and `.env.example` each contained a second, identical copy of
content that existed on both sides (`LeadIngestFingerprint`, the website-API variables); the duplicate was removed. `src/lib/csp.ts` was
re-applied on top of the merged file. `src/lib/migration-manifest.json` was regenerated with `npm run migrations:manifest`.
