# Deploying Compass Tools for a new company

Compass Tools is one codebase deployed **once per company**, each with its
own dedicated PostgreSQL database. There is no shared database and no
in-app "switch company" concept — isolation between companies comes from
each deployment only ever having access to its own database, not from
tenant filtering inside a shared one.

```
Compass Tools (same codebase)
     │
     ├── Deployment A ── DATABASE_URL → Postgres A ── Company A's data
     ├── Deployment B ── DATABASE_URL → Postgres B ── Company B's data
     └── Deployment C ── DATABASE_URL → Postgres C ── Company C's data
```

## 1. Provision a new PostgreSQL database

Any standard PostgreSQL provider works (this project's existing dev
database is hosted on Aiven; any Postgres 14+ instance is fine). Note the
connection string — this becomes this deployment's `DATABASE_URL`.

## 2. Set environment variables

Copy `.env.example` to `.env` (for local setup) or configure the same keys
in your hosting platform's environment variable settings (e.g. Vercel
Project → Settings → Environment Variables) for a real deployment:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | This deployment's own database. Never shared with another company's deployment. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Yes | Can be the **same** Google Cloud OAuth app shared across every company's deployment. **Both** of the following must be configured on that OAuth client for THIS deployment's domain — see §2a below for the exact steps; missing either one produces a real, previously-seen production failure. A separate Google Cloud project per company is not required. |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | Yes | Generate a fresh, unique value per deployment: `openssl rand -base64 32`. Never reuse across companies. |
| `APP_BASE_URL` | Recommended | This deployment's public URL. On Vercel this can usually be left unset and falls back to `VERCEL_PROJECT_PRODUCTION_URL`/`VERCEL_URL` automatically. |
| `CARD_ENCRYPTION_KEY` | Yes | Generate a fresh, unique value per deployment: `openssl rand -base64 32`. See `src/server/security/card-encryption.ts`'s file comment before handling real cardholder data. |
| `IP_ENCRYPTION_KEY` / `IP_HASH_KEY` | Yes | Two SEPARATE fresh values per deployment: `openssl rand -base64 32` (run it twice). See `src/server/security/ip-encryption.ts`'s file comment — one key reversibly encrypts a captured IP, the other produces a one-way search index; never reuse either across deployments or with each other. |
| `TRUSTED_PROXY` | Yes, in production | See §5 below. |
| `CRON_SECRET` | Recommended in production | See §5a below. |
| `APP_ENV` | Optional | Escape hatch for a deployment that runs a production-mode build (`NODE_ENV=production`, set automatically by `next build`/`next start`) but should still be treated as non-production by security-sensitive guards (card-vault selection, privileged step-up auth) — e.g. a staging environment. Falls back to `NODE_ENV` when unset, so a real production deploy is caught automatically either way. See `src/lib/env.ts`. |
| `BOOKING_IP_RETENTION_DAYS` | Deprecated — do not set | Pass 33: booking submission IP data is retained indefinitely by design; this variable is no longer read anywhere. Setting it does nothing. See `docs/ip-vault-compliance.md`. |

## 2a. Configure the Google OAuth client for THIS deployment's domain

This app uses **one Google OAuth client** (the `GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET` pair above) for **two separate flows** that each
need a **different** piece of configuration on that same client. Missing
either one produces a real production failure — Pass 36 traced a live
"Access blocked: Authorization Error … no registered origin … Error 401:
invalid_client" report to exactly this gap.

1. **Google Sign-In** (`src/components/layout/google-sign-in-button.tsx`,
   Google Identity Services — `accounts.google.com/gsi/client`, entirely
   client-side, no redirect at all). Google's script checks the **exact
   origin the browser's address bar is showing** (scheme + host + port,
   nothing else) against the client's **Authorized JavaScript origins**.
   If this deployment's real production origin isn't in that list, Google
   shows the user its own "no registered origin" / "Error 401:
   invalid_client" error — this app never even sees the failure, since it
   happens entirely inside Google's script before any request reaches this
   server.
2. **"Connect Gmail"** (`src/server/auth/gmail-oauth-config.ts`, a real
   server-side authorization-code redirect flow). Google checks the exact
   `redirect_uri` this app sends against the client's **Authorized redirect
   URIs**.

In Google Cloud Console, for the correct **Web application** OAuth client
(**Google Cloud Console → APIs & Services → Credentials**, or the newer
**Google Auth Platform → Clients**):

| Setting | Exact value for this deployment |
|---|---|
| Authorized JavaScript origins | `https://<this-deployment's-domain>` — **origin only**, no path, no trailing slash (e.g. `https://crm.example.com`, never `https://crm.example.com/login`) |
| Authorized redirect URIs | `https://<this-deployment's-domain>/api/auth/gmail/callback` — the exact path `getGmailRedirectUri()` builds (`src/server/auth/gmail-oauth-config.ts`) |
| Authorized domains (OAuth consent screen) | `<this-deployment's-domain>`, without a scheme |

For **local development**, add a second pair of entries on the same
client rather than replacing the production ones: JavaScript origin
`http://localhost:3000` (or whatever port `npm run dev` actually uses) and
redirect URI `http://localhost:3000/api/auth/gmail/callback`. Never let
`APP_BASE_URL` (or the absence of it) point production traffic at
`localhost` — `resolveBaseUrl()` warns loudly in production logs if that
happens (see `src/lib/company-config.ts`).

**Two common, easy-to-make mistakes that produce exactly this class of
error**, both now defended against in code (Pass 36) but worth knowing
about when configuring Google Cloud Console by hand:
- A trailing slash on `APP_BASE_URL` (e.g. `https://crm.example.com/`)
  used to produce a double-slash redirect_uri that would never match what's
  registered — `resolveBaseUrl()` now strips it automatically.
- A stray leading/trailing space or newline on `GOOGLE_CLIENT_ID`/
  `GOOGLE_CLIENT_SECRET` (easy to introduce pasting into Vercel's
  environment-variable UI) — `getGoogleClientId()`/`getGoogleClientSecret()`
  now trim the value automatically, but the value registered in Google
  Cloud Console itself must still be entered correctly.

If Google still rejects sign-in after the above is configured correctly,
also double-check: the OAuth client hasn't been deleted or disabled, it's
the **Web application** type (not "Desktop app" or "Other" — those have no
JavaScript-origins field at all), and `GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET` in this deployment's actual environment (Vercel
Project → Settings → Environment Variables) belong to that same client —
not a leftover value from a different Google Cloud project or an old
deployment.

## 3. Run database migrations

```bash
npx prisma migrate deploy
npx prisma generate
```

This is safe to run against a completely empty database — every migration
that seeds/backfills data (the `Company` row, `Account.companyId`,
`Contact.companyId`) is a no-op on zero existing rows and simply creates
the schema fresh.

## 4. Bootstrap the company and its first Admin

`prisma/seed.ts` seeds fake demo data (for local development only) — do
**not** run it against a real company's database. Instead:

```bash
npx tsx prisma/bootstrap-company.ts \
  --company-name "ABC Travel Agency" \
  --admin-name "Jane Smith" \
  --admin-email "jane@abctravel.com" \
  --website "https://abctravel.com" \
  --phone "+1 555 000 0000"
```

This creates exactly one `Company` row and one `ACTIVE` `Admin` `Account`
row — nothing else. It refuses to run if the database already has any
accounts (so it can't be accidentally re-run against a live company's
database). See the script's own header comment for why this bootstrap step
is necessary (the two-layer auth model's chicken-and-egg problem).

## 5. Set `TRUSTED_PROXY` correctly for this deployment's real infrastructure

This governs how the booking-signature audit trail determines a customer's
real IP address (`src/lib/request-ip.ts`) — get this wrong and either
booking IPs won't be captured at all, or (much worse) a malicious client
could spoof their recorded IP by sending a fake header.

- **Vercel** (this app's default target — see `vercel.json`): set
  `TRUSTED_PROXY=vercel`. Vercel's edge network is the sole hop between the
  customer and this app's serverless functions, so its `X-Forwarded-For` is
  authoritative there.
- **Cloudflare in front of the origin**: set `TRUSTED_PROXY=cloudflare`
  (trusts `CF-Connecting-IP`).
- **A custom nginx reverse proxy**: set `TRUSTED_PROXY=nginx`.
- **AWS Application Load Balancer (ALB) in front of the origin** (ECS/EC2/
  Fargate deployments): set `TRUSTED_PROXY=generic`. ALB appends the real
  client IP to `X-Forwarded-For` and does not let a client override it, so
  it satisfies the same "sets/overwrites, never blindly forwards a
  client-supplied value" requirement `generic` already documents below —
  there's no ALB-specific header to add special handling for.
- **Some other trusted reverse proxy/load balancer**: set
  `TRUSTED_PROXY=generic`.
- **Unsure, or no proxy in front of the app at all**: leave unset. The app
  will then trust no forwarded header and booking IPs will resolve to
  nothing rather than risk trusting a spoofable value — this is the secure
  default, not a bug. In production this also logs one warning the first
  time an IP capture is attempted (see `src/lib/request-ip.ts`'s
  `warnIfTrustedProxyMissingInProduction`), so a forgotten `TRUSTED_PROXY`
  doesn't stay silently invisible.

Never guess this value or copy it from another deployment without
confirming what actually sits in front of THIS one.

## 5a. Set `CRON_SECRET` and confirm the Vercel Cron job

`vercel.json` schedules exactly one cron job:

```json
{
  "crons": [{ "path": "/api/cron/tasks", "schedule": "0 3 * * *" }]
}
```

Vercel invokes `GET /api/cron/tasks` once daily, at 03:00 UTC, to process
due task notifications (`processDueTaskNotifications` — see that route's
own file comment). This once-daily schedule is required for compatibility
with the **Vercel Hobby/free plan**, which only permits cron jobs to run
once per day — a more frequent expression (e.g. every 5 minutes) fails
deployment on Hobby. **On Vercel Pro** (or higher), a more frequent
schedule is available again if desired — e.g. `*/5 * * * *` — since Pro
has no such restriction; only change it if you've actually upgraded the
project's plan.

The task-due query itself (`dueAt <= now + 1h`, gated by `dueNotifiedAt`
being unset) already catches any task that became due or overdue since the
last run, so a daily invocation still notifies every task — just less
promptly than a 5-minute schedule would; a task can now go up to ~24h past
its due time before its overdue notification fires. `processDueSequenceSteps`
(`/api/cron/sequences`) has the same catch-up property (`nextSendAt <= now`)
but is unaffected by this change since it isn't registered in `vercel.json`.

Two other maintenance routes exist at the same URL shape, `/api/cron/leads`
and `/api/cron/sequences`, but neither is currently registered in
`vercel.json` — they're reachable for manual/external triggering (e.g. an
external scheduler, or the in-app "Process Due Steps" button) but nothing
on Vercel calls them automatically today. Do not add duplicate cron
entries for them without a real product reason (and note that adding any
additional cron job on Hobby must also stay within once-per-day-per-job).

All three `/api/cron/*` routes accept an optional `CRON_SECRET`: if set,
a request must include it as `Authorization: Bearer <CRON_SECRET>` or the
route returns 401. **Vercel Cron sends this header automatically** for any
project that has `CRON_SECRET` configured as an environment variable — no
additional wiring needed beyond setting the variable. Leaving `CRON_SECRET`
unset leaves these routes open to anyone who requests the URL directly
(acceptable for local development, where nothing external can reach
`localhost`; **not acceptable once deployed anywhere public** — set it
before going live):

```bash
openssl rand -base64 32
```

## 6. First login and branding setup

Once deployed, the person whose email was passed to
`bootstrap-company.ts` signs in with Google. They land with full Admin
access and should visit `/company` to set the logo, brand color, and email
signature — everything else (name/website/phone) was already set in step 4
but can be edited there too.

## 7. Adding more users afterward

Every subsequent user (any role) is created by an existing Admin through
the in-app `/users` page — `prisma/bootstrap-company.ts` is only ever run
once, at initial setup.
