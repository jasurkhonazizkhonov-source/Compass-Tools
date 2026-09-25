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
| `INITIAL_ADMIN_EMAIL` | Recommended for first setup | The Google account that becomes this deployment's first Admin. See §2b below. Only matters until the first Account is created; safe (and recommended) to remove afterward. |
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

> **The single most common way Gmail Connect breaks — confirmed in
> production on 2026-09-24.** Google Sign-In working proves *nothing* about
> Gmail Connect. Sign-In uses Identity Services (an ID-token flow) which
> validates only the **Authorized JavaScript origin**; Gmail Connect uses
> the authorization-code flow, which validates the **Authorized redirect
> URI** — a completely separate field. A client can therefore have working
> Sign-In and a totally unregistered Gmail callback. Probing Google's
> authorize endpoint with this app's exact parameters returned
> `redirect_uri_mismatch` for the production host, the apex host *and*
> localhost — i.e. the redirect-URI list was empty — while Sign-In kept
> working perfectly. Google renders that as a page saying the app "doesn't
> comply with Google's OAuth 2.0 policies", which reads to users as
> "**\<domain\> is blocked**". If a user reports that phrase, check the
> redirect-URI list first; it is not an encryption-key, `APP_BASE_URL`, or
> application problem.
>
> **Match the canonical host exactly, including `www`.** Register the host
> users are actually served on. This deployment canonicalises to
> `https://www.compass-tools.com` (the apex 308-redirects to it), so the
> redirect URI must be
> `https://www.compass-tools.com/api/auth/gmail/callback` and `APP_BASE_URL`
> must be `https://www.compass-tools.com`. Registering the apex instead is
> not merely cosmetic: Google would send the browser to the apex, the apex
> would redirect to `www`, and the `gmail_oauth_state` cookie — set on
> `www`, host-scoped — would not be sent to the apex, so CSRF state
> validation would fail even though the URI "looks" registered.

For **local development**, add a second pair of entries on the same
client rather than replacing the production ones: JavaScript origin
`http://localhost:3000` and redirect URI
`http://localhost:3000/api/auth/gmail/callback`. `npm run dev` pins the
dev server to port 3000 explicitly (`next dev -p 3000` — see
`package.json`) specifically so this stays true: **Pass 40 traced a real
"Google Sign-In works, then stops working, on localhost" report to Next.js
dev server's own port-auto-retry behavior** — `next dev` (with no `-p`/
`PORT` given) silently starts on the next free port (3001, 3002, …)
whenever 3000 is already occupied by something else (confirmed directly in
`next/dist/server/lib/start-server.js`: this auto-retry is enabled
specifically — and only — when no port was explicitly requested). A
browser sitting on `http://localhost:3001` sends that origin to Google,
which was never registered — origin_mismatch, with no code-level symptom
to debug, and no obvious reason from the developer's point of view (they
just typed `npm run dev` the same way as always). Pinning the port makes
Next.js fail loudly with a clear "port 3000 is already in use" error
instead of silently drifting — if you ever see that error, something else
on your machine is holding port 3000; free it (or, if you deliberately
need a different port, update BOTH `package.json`'s `dev` script and the
Authorized JavaScript origin/redirect URI registered in Google Cloud
Console to match, consistently). Never let `APP_BASE_URL` (or the absence
of it) point production traffic at `localhost` — `resolveBaseUrl()` warns
loudly in production logs if that happens (see
`src/lib/company-config.ts`).

**Three common, easy-to-make mistakes that produce exactly this class of
error**, worth knowing about when configuring Google Cloud Console by hand:
- A trailing slash on `APP_BASE_URL` (e.g. `https://crm.example.com/`)
  used to produce a double-slash redirect_uri that would never match what's
  registered — `resolveBaseUrl()` now strips it automatically (Pass 36).
- A stray leading/trailing space or newline on `GOOGLE_CLIENT_ID`/
  `GOOGLE_CLIENT_SECRET` (easy to introduce pasting into Vercel's
  environment-variable UI) — `getGoogleClientId()`/`getGoogleClientSecret()`
  now trim the value automatically, but the value registered in Google
  Cloud Console itself must still be entered correctly.
- **Registering a per-deployment Vercel URL instead of the stable
  production alias** (Pass 39 — a real, reproduced "Error 400:
  origin_mismatch" report). Every single Vercel deployment — Production
  environment included — gets its OWN unique URL containing a random hash,
  e.g. `https://compass-tools-rhj9xf4i1-travel-agency1.vercel.app`
  (this is what `VERCEL_URL` holds). That hash-suffixed URL changes on
  **every new deployment** — registering it as an Authorized JavaScript
  origin only works until the next deploy. Vercel separately maintains a
  **stable** alias that always points at whichever deployment is currently
  live in Production — that's what `VERCEL_PROJECT_PRODUCTION_URL` holds,
  and what `resolveBaseUrl()` already prefers over the unstable
  `VERCEL_URL` (see the fallback order above) — or your own custom domain
  if one is configured. **Always register the stable alias/custom domain
  in Google Cloud Console, and always sign in through that same stable
  URL** — not a specific deployment's own link (e.g. one copied from the
  Vercel dashboard's deployment list or a deploy-comment link, which is a
  per-deployment URL by definition). If real users need to reach this
  deployment at a hash-suffixed URL specifically, that's a sign
  `APP_BASE_URL` (or the project's Production domain settings in Vercel)
  isn't configured the way this deployment actually needs — not something
  to work around by registering the ephemeral URL instead.

If Google still rejects sign-in after the above is configured correctly,
also double-check: the OAuth client hasn't been deleted or disabled, it's
the **Web application** type (not "Desktop app" or "Other" — those have no
JavaScript-origins field at all), and `GOOGLE_CLIENT_ID`/
`GOOGLE_CLIENT_SECRET` in this deployment's actual environment (Vercel
Project → Settings → Environment Variables) belong to that same client —
not a leftover value from a different Google Cloud project or an old
deployment.

## 2b. `INITIAL_ADMIN_EMAIL` — how the first Admin gets created

`INITIAL_ADMIN_EMAIL` names the exact Google account that becomes this
deployment's first Admin. It is checked entirely server-side, on every
Google sign-in attempt, but only ever has an effect while the database
has **zero** `Account` rows:

- **Database empty, the signed-in Google email matches
  `INITIAL_ADMIN_EMAIL` (case-insensitive, trimmed):** an `ACTIVE` `Admin`
  `Account` is created automatically (reusing the existing `Company` row
  every freshly-migrated database already has — see §3 below — rather than
  creating a second one), and that person is signed into the CRM.
- **Database empty, the signed-in Google email does NOT match:** access is
  denied with "This Google account is not authorized for the initial CRM
  administrator." Nothing is created, nothing is revealed about what the
  configured email actually is.
- **Database empty, `INITIAL_ADMIN_EMAIL` is unset or blank:** access is
  denied with a message explaining the deployment hasn't been initialized
  yet — never silently lets the first Google user in, never picks a random
  Admin.
- **Once ANY `Account` exists** (created this way, via the CLI script, or
  by hand) — `INITIAL_ADMIN_EMAIL` **permanently stops having any effect**,
  including for its own configured email if it signs in again later. It is
  never a standing privilege-escalation mechanism. From that point on,
  every sign-in — including the first Admin's own subsequent logins — goes
  through the normal, existing Account-lookup authorization path (§7).
- **Concurrency:** if two requests race to bootstrap at the exact same
  moment (e.g. a double-click, or two browser tabs), the database
  guarantees exactly one Admin `Account` is ever created — the other
  request's sign-in simply resolves through the normal authorization path
  against the Account the first one just created.

Safe to leave configured indefinitely after the first Admin exists (it has
no effect once any Account exists), but removing it once setup is done is
a reasonable extra precaution with no downside.

## 3. Run database migrations

```bash
npx prisma migrate deploy
npx prisma generate
```

This is safe to run against a completely empty database — every migration
that seeds/backfills data (the `Company` row, `Account.companyId`,
`Contact.companyId`) is a no-op on zero existing rows and simply creates
the schema fresh.

### 3a. Automatic migrations on Vercel (`scripts/vercel-build.mjs`)

On Vercel the `vercel-build` script runs `prisma migrate deploy` before
`next build`. It is deliberately conservative and never destructive:

| Database state | What happens |
|---|---|
| Already has the `Company` table or Prisma's `_prisma_migrations` history (the normal case) | `prisma migrate deploy` runs — a no-op when up to date, or applies only the migrations that are missing. Existing data is never touched. |
| Completely empty (no Compass Tools footprint) | **Nothing is created** unless `DATABASE_AUTO_INIT=true` is set for that environment. Without it the build logs why and continues. This stops a mistyped/stale `DATABASE_URL` from silently turning an unrelated empty database into an orphaned CRM. |
| Unreachable, or a migration fails | Logged (credentials redacted) and the build continues; the app's runtime error handling covers the rest. It never drops, resets or force-pushes anything. |

Verified against real PostgreSQL by `scripts/__integration__/vercel-build.integration.test.ts`
(empty, empty + opt-in, healthy-with-data, partially migrated, failing
migration). See §8 for how to run it.

## 4. Bootstrap the company and its first Admin

`prisma/seed.ts` seeds fake demo data (for local development only) — do
**not** run it against a real company's database.

Two ways to create the first Admin — pick whichever fits how you're
deploying:

**Option A — `INITIAL_ADMIN_EMAIL` (recommended for Vercel):** the
preferred path for a serverless deployment with no direct shell access to
production. Set `INITIAL_ADMIN_EMAIL` (see §2b above) to the exact Google
account that should become the first Admin, deploy, and have that person
sign in with Google — the CRM creates their Admin account automatically on
that first successful sign-in. No CLI access to the production database is
needed.

**Option B — the `bootstrap-company.ts` CLI script:** for a local/
self-hosted deployment where you already have a shell with the production
`DATABASE_URL` available:

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

Both options refuse to do anything once the database has any existing
Account — neither is a standing way to create additional Admins later; see
§7 below for that.

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

## 5c. Enabling customer bookings in production (a deliberate decision)

The customer booking form collects card details, and this CRM stores them
with an **application-level encryption key — a development-grade vault that
is explicitly NOT PCI DSS compliant** (see the warnings in
`src/server/security/card-encryption.ts` and `payment-vault.ts`). To make sure
that is never used by accident, the vault **refuses to run when the
environment is production** (`APP_ENV=production`, or `APP_ENV` unset on a
production build). In that state every customer's "Finish Booking" is rejected
with a message that nothing was charged and no booking was recorded — the
Admin banner in the CRM and `GET /api/health` (`readiness.bookingCardStorage`)
both report it as `unavailable`.

Choose one, on purpose:

1. **Accept the development-grade vault for this deployment** (the choice
   documented for this project): set `APP_ENV` to any value other than
   `production` (for example `staging`) in Vercel → Settings → Environment
   Variables, then redeploy. Do this only if you have accepted the compliance
   position of storing card numbers this way; it does **not** make card
   storage any safer, it only lifts the guard.
2. **Wire a real, PCI-compliant vault or a tokenizing processor** in
   `getPaymentVault()` before taking real cards (the recommended long-term
   answer). Leave `APP_ENV` unset until then.

Separately, set `TRUSTED_PROXY=vercel` (section 5) so the signer's IP address
is captured and the public forms are rate limited; `readiness.signerIpCapture`
reports `disabled` until you do.

## 5b. Database connection settings, region and health check

The CRM issues many small queries per page, so **latency between the
serverless function and the database is the single biggest performance and
reliability factor**. Two things matter more than any code setting:

1. **Region.** In Vercel → Project → Settings → Functions, set the Function
   Region to the region closest to your PostgreSQL host. (Measured on this
   project's original deployment: functions ran in `iad1` with roughly
   half a second per database round trip.)
2. **A connection pooler**, if your provider offers one (Aiven, Neon,
   Supabase, PgBouncer): point `DATABASE_URL` at it. Many serverless
   instances each opening their own connections is what exhausts small
   databases.

Optional per-instance tuning (defaults are sensible; see `src/lib/prisma.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_POOL_MAX` | `2` | Max connections per server instance. Keep `instances x this` under your database's connection limit. |
| `DATABASE_POOL_CONNECT_TIMEOUT_MS` | `8000` | How long one attempt waits for a free connection. |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | `4000` | How long an idle connection is kept. The instance is held alive just long enough after each request for this to fire before the platform suspends it (a suspended process cannot close its connections, which otherwise stay counted against the database's limit). |
| `DATABASE_CONNECT_RETRIES` | `6` | Extra attempts (jittered exponential backoff, up to ~4s apart) when acquiring a connection times out or the database is momentarily out of connection slots (SQLSTATE 53300). Only the connection-acquire step is retried, so a write can never be duplicated. |

**Health check.** `GET /api/health` is public and returns database
round-trip times and pool occupancy (no hostnames, credentials or queries),
e.g. `{"status":"ok","database":{"ok":true,"secondQueryMs":68},"pool":{"max":2,...}}`. Under a burst it also reveals why it fails, e.g. `PrismaClientKnownRequestError(P2010/TooManyConnections/53300)` means the database is out of connection slots.
`secondQueryMs` is the steady-state cost of one database round trip: if it
is in the hundreds, the database is far from the functions (fix the region).
It returns HTTP 503 with a safe error category when the database is unreachable.

**Correlating a "This page couldn't load — Error ref: NNN" screen.** The
number is the Next.js error digest. Search the deployment's Runtime Logs for
that exact number: the server logs the underlying error next to it, plus a
`[crm-layout]` / `[proxy]` / `[booking]` line with a safe error category.

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

## 8. Running the real-database integration tests

The normal `npm test` never needs a database. The tests that prove
transactional and concurrency behaviour run only against a **disposable**
PostgreSQL you point them at (they create and delete their own rows; the
recovery test creates and drops its own scratch database — never use a
server holding data you care about):

```bash
# 1. a scratch database with the migrations applied
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/scratch npx prisma migrate deploy

# 2. booking atomicity/idempotency/concurrency + lead-queue concurrency
INTEGRATION_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/scratch \
  npx vitest run src/server/actions/__integration__

# 3. deploy-time recovery logic (creates/drops its own database on that server)
INTEGRATION_ADMIN_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres \
  npx vitest run scripts/__integration__
```
