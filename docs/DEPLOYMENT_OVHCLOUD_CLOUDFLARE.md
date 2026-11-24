# Deploying Compass Tools on an OVHcloud VPS (Docker Compose + Cloudflare Tunnel)

This is the runbook for the **self-hosted** deployment: the Next.js app and PostgreSQL run as containers on one OVHcloud VPS, and
the public reaches them only through a **Cloudflare Tunnel** (`cloudflared`). Nothing listens for inbound connections on the VPS
except SSH.

> **Pushing to GitHub does not deploy anything.** The VPS only changes when a person runs `deploy/deploy.sh` on it. CI
> (`.github/workflows/ci.yml`) checks code; it has no access to the VPS, Cloudflare or any secret.

Not covered here: Vercel ([DEPLOYMENT.md](DEPLOYMENT.md)) and Cloudflare **Workers** ([CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md) —
a different hosting model that is *not* production-ready and is *not* what this guide uses; the Worker files can stay in the repository
and are ignored by the Docker build).

## Contents

0. [Architecture, findings and decisions](#0-architecture-findings-and-decisions)
1. [Prerequisites](#1-prerequisites)
2. [Environment variables (`.env`)](#2-environment-variables-env)
3. [Initial VPS setup](#3-initial-vps-setup)
4. [Safe Docker deployment](#4-safe-docker-deployment)
5. [Database migrations](#5-database-migrations)
6. [Cloudflare Tunnel configuration](#6-cloudflare-tunnel-configuration)
7. [DNS and the canonical domain](#7-dns-and-the-canonical-domain)
8. [Google OAuth and Gmail callbacks](#8-google-oauth-and-gmail-callbacks)
9. [HTTPS, proxy and health verification](#9-https-proxy-and-health-verification)
10. [Daily CVV cleanup](#10-daily-cvv-cleanup)
11. [Logs and troubleshooting](#11-logs-and-troubleshooting)
12. [PostgreSQL backup and restore](#12-postgresql-backup-and-restore)
13. [Routine updates from GitHub](#13-routine-updates-from-github)
14. [Rollback](#14-rollback)
15. [Secret rotation and recovery](#15-secret-rotation-and-recovery)
16. [Known limitations and security / compliance warnings](#16-known-limitations-and-security--compliance-warnings)
17. [Moving existing data from the current database](#17-moving-existing-data-from-the-current-database)
18. [Updating base images, and the dependency audit](#18-updating-base-images-and-the-dependency-audit)
19. [Release 2026-11-20 - redeployment checklist](#19-release-2026-11-20-failed-sign-ins-customer-email-privacy-subscriptions-and-queued-campaigns---redeployment-checklist)

---

## 0. Architecture, findings and decisions

```
 Browser ──HTTPS──▶ Cloudflare edge ──(outbound tunnel, encrypted)──▶ cloudflared ──http://app:3000──▶ app ──▶ db
                      TLS, WAF, redirects              container "cloudflared"      (Next.js)    (PostgreSQL 17)
                                                          network: web             web + data       data (internal, no internet)
```

| Container | Image | Networks | Published ports | Holds |
|---|---|---|---|---|
| `db` | `postgres:17.11-bookworm@sha256:…` | `data` (internal: **no internet**) | **none** | volume `postgres-data` |
| `app` | built from `Dockerfile` (target `runner`, Node 24, non-root) | `data`, `web` | **none** (`expose 3000` is container-to-container only) | nothing persistent |
| `cloudflared` | `cloudflare/cloudflared:2026.10.0@sha256:…` | `web` | **none** (outbound only) | `TUNNEL_TOKEN` only |
| `cvv-cleanup` | same image as `app` | `web` | none | `CRON_SECRET` only |
| `tools` (on demand) | `Dockerfile` target `tools` | `data` | none | database access for migrations / ops scripts |

Each container is given **only the variables it needs** (see `compose.yaml`): the tunnel token never reaches the app and the app never
sees tunnel credentials. Because `db` is on an `internal` network and nothing publishes a port, the database cannot be reached from the
internet *or even from other hosts on the VPS's network*.

### What the inspection found (and what was changed)

| # | Finding | Resolution |
|---|---|---|
| 1 | The repository had **no** Dockerfile, Compose file, deploy scripts or CI. The VPS-only TLS change (`DATABASE_SSL_MODE`) was **not** in GitHub. | All added on branch `feature/vps-docker-cloudflare-tunnel`. The VPS copy of `db-tls.ts` was *not* copied over: the option was re-implemented (see §0.1) after reviewing the repo version. |
| 2 | The app always sent TLS options to PostgreSQL, so a plaintext Docker database failed with *"The server does not support SSL connections"* (reproduced). | `DATABASE_SSL_MODE=disable`, guarded (§0.1). |
| 3 | Three operational scripts (`prisma/seed.ts`, `scripts/backfill-airport-timezones.ts`, `scripts/find-incomplete-bookings.ts`) hard-coded `rejectUnauthorized:false`, ignoring `DATABASE_SSL_CA` and unusable against a plaintext database. | Now use the same resolver as the app. (`scripts/vercel-build.mjs`, `fresh-database-check.ts` and `migration-safety-check.ts` still hard-code it; they are Vercel/CI tools that talk to test or managed databases.) |
| 4 | `sharp` (native image library) was imported at module load, on the server's **start-up path** (`instrumentation.ts` → tasks → company queries). Next's file tracer does not always copy sharp's libvips libraries into a standalone build. Reproduced on a Windows build, where the traced output lacked sharp's DLLs: the server **failed to start** and every request returned 500. The Linux libvips files are not guaranteed to be traced either, and Docker could not be run where this was developed. | `sharp` is now loaded on first use (`src/lib/logo-processing.ts`), the Dockerfile copies the complete `@img` packages, and a test proves the server boots with sharp absent. |
| 5 | `destroyExpiredCvvs()` swallowed errors and returned `{deleted: 0}`, so "failed" looked like "nothing to delete". | Returns `failed: true`; used by the new dedicated endpoint. |
| 6 | The repository had no way to run only the CVV cleanup. `/api/cron/tasks` also sends notifications, runs the opt-in card-number purge and other maintenance. | New `POST /api/cron/cvv-cleanup` + the `cvv-cleanup` scheduler container (§10). |
| 7 | The System Health page said the card security code is *"Never collected or stored"* — outdated since the 24-hour retention was added. | Corrected to the real behaviour. |
| 8 | `pg_dump` backups would keep retained CVV ciphertext for as long as the backup lives. | `deploy/backup-db.sh` excludes that table's data (§12). |
| 9 | `src/instrumentation.ts` starts a task-notification poller (every 60 s) in **every** server process, including production. On Vercel that is mostly inert; on a long-running VPS it is the thing that delivers task-due notifications. | No change. Documented in §10.3. |
| 10 | Migrations vs `schema.prisma`: the migrated database differs by exactly two leftover enum labels (`PaymentChargeStatus.REFUNDED`, `PARTIALLY_REFUNDED`) — intentional, PostgreSQL cannot drop enum values (migration `20260926000300`). | CI tolerates exactly that and fails on any **new** difference (`deploy/check-migration-drift.sh`, proven both ways). |
| 11 | Approximate visitor **location** is read only from Vercel headers (`x-vercel-ip-*`). | On the VPS the signer's **IP** is still captured (via `CF-Connecting-IP`); the approximate location is not. See §16. |
| 12 | On 2026-10-09 `www.compass-tools.com` returned **NXDOMAIN** from public resolvers and the Vercel status for the latest commit read *"Account is blocked"*. | Not caused by this work and not changed. §7 covers the records to create. |

### 0.1 Database TLS: which mode where

| Where the database is | Setting | Why |
|---|---|---|
| **PostgreSQL in the private Docker network** (this deployment) | `DATABASE_SSL_MODE=disable` (set by `compose.yaml`) | The server in the container does not offer TLS. The network is internal, has no internet access and carries only app ↔ db traffic. |
| **Remote managed database** (Aiven, RDS, …) | leave `DATABASE_SSL_MODE` **unset**; set `DATABASE_SSL_CA` (provider's CA PEM) or `DATABASE_SSL_VERIFY=system` | Verified TLS: certificate **and** host name are checked. |
| Anything else | unset everything | Encrypted but *not identity-verified* (the historical default; the System Health page flags it). |

`DATABASE_SSL_MODE=disable` is an explicit opt-in that the code refuses unless **all three** conditions hold
(`src/lib/db-tls.ts`; 82 unit tests in `src/lib/__tests__/db-tls.test.ts`. A one-off real-handshake check against TLS and plaintext servers
was also run during development; it is not part of the test suite):

1. the value is exactly `disable` (`off`, `false`, `no`, `require`, … are refused, never guessed);
2. `DATABASE_SSL_CA` / `DATABASE_SSL_VERIFY` are **not** also set (a contradictory configuration is refused);
3. the hostname in `DATABASE_URL` is **exactly one** of the following, compared case-insensitively (so `DB` is `db`), and the URL has
   **no `host=` or `hostaddr=` query parameter**:

   | Allowed host | Why |
   |---|---|
   | `db` | the PostgreSQL service defined in `compose.yaml` — the one real use of plaintext in this deployment |
   | `localhost`, `127.0.0.1`, `::1` | loopback only, for a developer running a non-TLS PostgreSQL on their own machine; the traffic never leaves that machine |

   Nothing else is accepted. In particular these are **refused**: any other single-label name (such as `postgres`), every `*.internal` name,
   `host.docker.internal`, **private-range IP addresses** (10.x, 172.16–31.x, 192.168.x, `fc00::/7`, link-local), other loopback addresses
   such as `127.0.0.2`, public host names and IP addresses, managed-database host names, and malformed or abbreviated forms
   (`127.1`, `db.`, `[db]`). A missing, empty or unparseable `DATABASE_URL` is refused too.

   **Why `host=` / `hostaddr=` are rejected:** the `pg` driver lets those query parameters *override* the host written in the URL. A URL such
   as `postgresql://u:p@db/x?host=other.example` would pass a check of its host name yet connect to `other.example`, in plaintext. Because
   the host actually used could not be known, any URL carrying either parameter is refused when plaintext mode is on.

**This is a configuration guardrail, not proof of a private network.** It exists to stop a typo or a copied `.env` from sending an
unencrypted connection to an unintended host. A host *name* cannot establish where it resolves: the container's DNS, hosts file or Docker
network could make `db` point at another machine, and no DNS lookup is performed. The real protection is that the PostgreSQL container
**stays on the `internal` Docker network (`data`, no route to the internet) and publishes no port**, as `compose.yaml` configures. A CI
test (`src/__tests__/selfhost-deployment-config.test.ts`) checks that layout in `compose.yaml`, and `deploy/verify.sh` checks that no
container publishes a host port; neither can see a change made by hand on the server. Do not add a `ports:` entry to `db`, do not attach
it to the `web` network, and do not put any container you do not control on `data`.

Plaintext applies **only** to that internal Docker database. A **remote managed database** always uses verified TLS (`DATABASE_SSL_CA` or
`DATABASE_SSL_VERIFY=system`) with `DATABASE_SSL_MODE` unset; the verified modes never consult the allow-list. To use plaintext against any
other host, the allow-list in `src/lib/db-tls.ts` has to be changed in a reviewed commit.

The URL's own `?sslmode=` is ignored by the app (it strips it and decides from `DATABASE_SSL_MODE` alone). The Prisma **CLI**
(migrations) reads `sslmode` from the URL — and does not use this allow-list — which is why `compose.yaml` also appends `?sslmode=disable`
for it.

### 0.2 Decisions that are yours (nothing proceeds until you decide)

1. **Cut-over date and data move** (§17): whether the VPS takes over from the current database, and when. The Docker stack starts with an
   *empty* database.
2. **Daily maintenance** (§10.3): `/api/cron/tasks` (rate-limit cleanup, stale-upload sweep) is **not** scheduled until you install the
   shipped systemd timer yourself. Do you want it scheduled? (Recommended, because of the uploaded documents.) (Task notifications are already covered; the opt-in card-number purge stays off.)
3. **OVHcloud snapshots / automated VPS backups** (§16.3): they capture the whole disk — database volume **and** `.env` (the keys). Enable
   them only knowingly.
4. **Off-server backup copy** (§12.3): where encrypted backups go, and who holds the decryption key.
5. **The card vault stays closed** (`CARD_VAULT_MODE` unset) and **`CARD_RETENTION_DAYS` stays unset** until you decide. Nothing in this
   repository sets either.
6. **Dependency upgrades** (§18): `nodemailer` needs a major version bump; TipTap/ProseMirror need minor bumps. Each needs regression testing.

---

## 1. Prerequisites

* An OVHcloud VPS: Ubuntu **26.04 LTS**, 2 vCPU / 4 GB RAM / 40 GB NVMe is enough (the app is limited to 1.5 GB, the database to 1 GB).
* Root or `sudo` SSH access, and an SSH **key** (not a password).
* A Cloudflare account that already manages the `compass-tools.com` zone, and the tunnel **`compass-tools-vps`**
  (expected tunnel ID `ae4f995a-03d2-4fdf-bb4a-8bbd07839be7` — confirm it in the dashboard; the connector token encodes the ID, so the ID is
  never typed anywhere in this repository).
* Access to the Google Cloud project that owns the OAuth client (§8).
* This repository on GitHub (`jasurkhonazizkhonov-source/Compass-Tools`). It is public, so the VPS can `git clone` over HTTPS with no
  credentials. If it is ever made private, add a read-only **deploy key** instead.

Never paste the tunnel token, `.env`, OAuth secrets, API tokens or private keys into chat, tickets, commits or screenshots.

## 2. Environment variables (`.env`)

All configuration lives in **one file on the VPS**: `/opt/compass-tools/.env`, mode `600`. It is git-ignored, excluded from the Docker build
context (`.dockerignore`) and checked by CI never to be tracked.

```bash
cd /opt/compass-tools
cp .env.example .env
chmod 600 .env
nano .env        # replace EVERY placeholder
```

Generate secrets **on the server** (never reuse a value from a file, a chat or another environment):

```bash
openssl rand -hex 32        # POSTGRES_PASSWORD
openssl rand -base64 32     # GMAIL_TOKEN_ENCRYPTION_KEY, CARD_ENCRYPTION_KEY, IP_ENCRYPTION_KEY, IP_HASH_KEY, CRON_SECRET, LEAD_INGEST_SECRET
```

> **If you are moving an existing deployment**, `CARD_ENCRYPTION_KEY`, `CARD_ENCRYPTION_KEYS`/`CARD_ENCRYPTION_KEY_ID`,
> `GMAIL_TOKEN_ENCRYPTION_KEY`, `IP_ENCRYPTION_KEY` and `IP_HASH_KEY` must be the **same values** the existing data was encrypted with
> (copy them from the current host's secret store). Generating new ones makes stored cards, Gmail connections and IP records unreadable.

| Variable | Required | Notes |
|---|---|---|
| `APP_BASE_URL` | yes | `https://www.compass-tools.com`. **Baked into the static pages at build time** and used for the Gmail OAuth redirect URI at run time → changing the domain needs a rebuild. Must be `https://`. |
| `POSTGRES_PASSWORD` | yes | Hex only (no characters needing URL escaping). Also builds the app's `DATABASE_URL` (`compose.yaml` does this; you never write `DATABASE_URL` for Docker). |
| `POSTGRES_USER`, `POSTGRES_DB` | no | Default `compass`. Only applied when the volume is first created. |
| `TUNNEL_TOKEN` | yes | Cloudflare dashboard → Networking → Tunnels → `compass-tools-vps`. A **secret**. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | The existing OAuth client (§8). |
| `INITIAL_ADMIN_EMAIL` | first start only | The Google account that becomes the first Admin; inert once any account exists (DEPLOYMENT.md §2b). |
| `GMAIL_TOKEN_ENCRYPTION_KEY`, `CARD_ENCRYPTION_KEY`, `IP_ENCRYPTION_KEY`, `IP_HASH_KEY` | yes | See the warning above. |
| `CRON_SECRET` | yes | Without it every `/api/cron/*` endpoint answers 503 in production and the CVV job cannot run. |
| `CARD_VAULT_MODE` | **leave unset** | Empty = vault **closed**. Only the owner sets `application-encryption-risk-accepted`. Not set by any file here. |
| `CARD_RETENTION_DAYS` | **leave unset** | Empty = no automatic card-number purge. |
| `CARD_ENCRYPTION_KEYS`, `CARD_ENCRYPTION_KEY_ID` | optional | Key ring for rotation (CARD_VAULT_SECURITY.md §6). |
| `WEBSITE_API_KEY` | Zero-downtime rotation with `WEBSITE_API_KEY_NEXT` (docs/WEBSITE_LEAD_API.md, "Rotating the key"): add the new key, switch the website, then remove the old one | Both keys are accepted during the overlap. |
| `LEAD_INGEST_SECRET` | optional | Must equal the travel website's value; ≥ 32 characters. |
| `WEBSITE_API_KEY`, `WEBSITE_API_KEY_NEXT`, `WEBSITE_API_COMPANY_ID`, `WEBSITE_API_ALLOW_PUBLIC_ROUTE` | optional | The authenticated website API (docs/WEBSITE_LEAD_API.md). Empty key = the API answers 503. Generate the key with `openssl rand -hex 32`. |
| `UPLOADS_HOST_DIR` | optional | Host directory for Lead documents (default `/srv/compass-tools/uploads`; **create it first**, §3.4). |
| `UPLOAD_MIN_FREE_MB`, `MAX_LEAD_ATTACHMENT_SIZE_MB` | optional | Disk reserve kept free (default 1024) and largest accepted file (default 10, max 25). LEAD_ATTACHMENTS.md. |
| `CLEANUP_HEARTBEAT_URL` | optional | A dead-man's-switch URL pinged after each successful cleanup. |
| `DATABASE_POOL_*`, `DATABASE_CONNECT_RETRIES` | optional | Leave unset. |

Rules for the file: a literal `$` must be written `$$`; no spaces around `=`; quotes are optional. Compose refuses to start
(`Set X in .env`) if a required value is missing. **Back up `.env` separately and off the server** (a password manager): without the card
and Gmail/IP keys the database backups cannot be used.

## 3. Initial VPS setup

Run as `root` (or with `sudo`) on a fresh Ubuntu 26.04 VPS. Review each block before pasting.

### 3.1 System, a non-root deploy user, SSH

```bash
apt-get update && apt-get -y upgrade
apt-get -y install ufw unattended-upgrades ca-certificates curl git openssl age

adduser --disabled-password --gecos "" deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys

# key-only SSH, no root login (confirm you can open a SECOND session as deploy before closing this one)
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh

# firewall: nothing inbound except SSH (the tunnel is outbound-only)
ufw default deny incoming && ufw default allow outgoing && ufw allow OpenSSH && ufw --force enable
dpkg-reconfigure -plow unattended-upgrades
```

### 3.2 Swap (the image build needs ≈ 3 GB; 4 GB RAM is tight)

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### 3.3 Docker Engine and Compose (Docker's official apt repository; it publishes `resolute` = Ubuntu 26.04)

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker compose version        # needs Compose v2.24 or newer
usermod -aG docker deploy     # NOTE: the docker group is root-equivalent: only the deploy account, never a shared one
```

### 3.4 Get the code and prepare directories

```bash
install -d -o deploy -g deploy /opt/compass-tools
install -d -m 700 -o deploy -g deploy /var/backups/compass-tools
# Lead documents: owned by the container user (uid/gid 1000), NOT by deploy. Compose refuses to start without it.
sudo install -d -o 1000 -g 1000 -m 0700 /srv/compass-tools/uploads
su - deploy
cd /opt && git clone https://github.com/jasurkhonazizkhonov-source/Compass-Tools.git compass-tools
cd compass-tools && git log -1 --oneline
```

Then create `.env` (§2). Make the scripts executable once: `chmod +x deploy/*.sh` (the repository records the executable bit, so this is
normally already set; running them as `bash deploy/<name>.sh` always works).

## 4. Safe Docker deployment

The first deployment (empty database) and every later one use the same script:

```bash
cd /opt/compass-tools
bash deploy/deploy.sh --migrate       # first time: needs --migrate because the empty database has migrations to apply
```

What it does, in order — and where it stops instead of continuing:

1. **Pre-flight**: `.env` exists with mode `600`; the git checkout is **clean** (local edits are never overwritten or discarded —
   it stops); `git fetch`; the target commit must already be on `origin/main` (or, with `--release-branch release/<name> --ref <full sha>`, be on that
   release branch with green CI - §19.7).
2. Shows the incoming commits and which `prisma/migrations` files they add, and asks you to confirm (`--yes` skips the question).
3. Updates the checkout with `git merge --ff-only` (never a reset or a merge commit).
4. Builds the images, tagged with the commit id (`compass-tools:<commit>`), so the previous version remains for rollback.
5. **Migration gate** (§5): pending migrations **stop** the deploy unless you passed `--migrate`.
6. `docker compose up -d` for `db`, `app`, `cvv-cleanup`, `cloudflared`; waits for the app's health check.
7. Runs `deploy/verify.sh` (§9).
8. Keeps the 5 newest image versions and removes older ones.

First start only: `INITIAL_ADMIN_EMAIL` lets that Google account sign in as the first Admin (DEPLOYMENT.md §2b). Reference data (airports,
airlines, aircraft) seeds itself on first use; no manual seed is needed. Do **not** run `prisma/seed.ts` without `--reference-data-only`.

Manual equivalent (what the script wraps): `docker compose up -d --build`. Prefer the script — it adds the gates above.

## 5. Database migrations

* Migrations are **forward-only** and **deliberate**. `deploy.sh` never applies one unless you pass `--migrate`; the only command it runs is
  `prisma migrate deploy`, which applies pending migrations and nothing else (it cannot reset, drop or `db push`).
* With `--migrate` on a database that already has tables, **a verified backup is taken first** (§12). On the very first deployment there is
  nothing to back up and the script says so.
* Look before you apply:
  ```bash
  bash deploy/compose.sh run --rm tools                          # prisma migrate status (read-only; this is the default command)
  git diff --stat <old>..<new> -- prisma/migrations              # which migrations are coming
  ```
* Apply by hand if you must: `bash deploy/compose.sh run --rm tools npx prisma migrate deploy` (take a backup first: `bash deploy/backup-db.sh`).
* **Never** run `prisma migrate reset`, `prisma migrate dev`, `prisma db push` or `DROP` against this database. The `tools` container cannot
  reach the internet, so a stray command can only ever talk to this database — which is why the discipline matters.
* An old application image running against a newer schema is normal for a rollback (§14); migrations in this project are written to be
  additive. The CI job `deploy/check-migration-drift.sh` fails a change that edits `schema.prisma` without a migration.

## 6. Cloudflare Tunnel configuration

The tunnel is **remotely managed**: the connector token selects the tunnel, and the routes are configured in the Cloudflare dashboard, not
in a file here. (Menu names follow Cloudflare's current documentation; the dashboard layout changes, so search for "Tunnels" if a path moved.)

1. Dashboard → **Networking → Tunnels → `compass-tools-vps`**. Confirm the ID is `ae4f995a-03d2-4fdf-bb4a-8bbd07839be7` and that **no
   other connector** you do not recognise is attached.
2. **Published application routes** (the "Routes" tab). Add **two**:

   | Hostname | Service type | URL |
   |---|---|---|
   | `www.compass-tools.com` | HTTP | `app:3000` (shown as `http://app:3000`) |
   | `compass-tools.com` | HTTP | `app:3000` |

   `app` resolves because `cloudflared` and `app` share the Compose network `web`. Leave the origin "Additional application settings" at
   their defaults (no custom Host header, no TLS options — the origin is plain HTTP, and the app does not redirect HTTP to HTTPS, so there is
   no redirect loop). Keep the final catch-all rule the dashboard adds (`http_status:404`).
3. Adding a route creates a **proxied CNAME** `→ <TUNNEL_ID>.cfargotunnel.com` for that hostname in the zone (§7).
4. Copy the connector **token** (shown once in the install snippet, or via "Refresh token") **directly into `.env`** on the server.
5. Start the connector (it is part of the stack): `bash deploy/compose.sh up -d cloudflared`, then check the tunnel shows **Healthy** in the dashboard
   and `docker compose logs --tail=30 cloudflared` shows registered connections.
6. Dashboard → **Notifications**: add a *Tunnel health* alert (email) so a down tunnel is noticed.

Why `TRUSTED_PROXY=cloudflare` is safe here: the app trusts `CF-Connecting-IP`, which anyone could forge **if they could reach the app
directly**. They cannot: the app publishes no port and is on a Docker network shared only with `cloudflared` and the cleanup job. Never add
a `ports:` entry to the `app` service, and never put another container on `web` that you do not control.

## 7. DNS and the canonical domain

The canonical hostname is **`https://www.compass-tools.com`** (confirmed against `docs/DEPLOYMENT.md` and `src/app/layout.tsx`). Everything
that depends on it — `APP_BASE_URL`, the Gmail redirect URI, customer-facing links, canonical URLs and the sitemap — must use exactly that
origin, including the `www`.

**Before touching DNS, export the zone**: Cloudflare → DNS → Records → **Export** (BIND file); keep it somewhere safe.

| Record | Needed for the website? | Action |
|---|---|---|
| `www` CNAME → `<TUNNEL_ID>.cfargotunnel.com` (proxied) | **yes** | Created by step 2 of §6. If a `www` record already exists (for example pointing at Vercel), the dashboard will refuse to overwrite it: identify what it is, then *edit* that record deliberately. |
| `@` (apex) CNAME → the same target (proxied) | yes (so the redirect rule can run) | Created by step 2 of §6, subject to the same caveat. |
| `MX`, `TXT` (SPF `v=spf1…`, DKIM, DMARC `_dmarc`), `google-site-verification`, any `CNAME` for an email/marketing provider | **no — unrelated to hosting** | **Do not touch.** These keep email and domain verification working. |
| Any old `A`/`AAAA`/`CNAME` on `@` or `www` pointing at Vercel (e.g. `76.76.21.21`, `cname.vercel-dns.com`) | replaced by the tunnel records | Remove **only after** you have confirmed what each one is and that the site works through the tunnel. |
| Any record that exposes the VPS IP (e.g. an `A` record to the VPS, a grey-cloud "DNS only" record) | **no** | Do not create one: it would bypass the tunnel and Cloudflare's protections. |

Observation to be aware of (2026-10-09, from public resolvers): `www.compass-tools.com` had **no record** (NXDOMAIN) while the apex resolved
to Cloudflare. So the `www` record likely needs to be *created* rather than edited — check the zone before assuming.

### Apex → www redirect

Previously Vercel redirected the apex to `www`. With a tunnel, that redirect belongs **at the Cloudflare edge** (nothing reaches the VPS):

Dashboard → the zone → **Rules → Redirect Rules → Create rule** (Single Redirect):

* *If* hostname **equals** `compass-tools.com`
* *Then* **Dynamic** redirect to `concat("https://www.compass-tools.com", http.request.uri.path)` — status **308** — **preserve query string**: on.

Single Redirects only work for hostnames that are **proxied** by Cloudflare — which is why the apex gets a (proxied) tunnel record. Do not
also redirect inside the app: two redirect layers cause loops.

## 8. Google OAuth and Gmail callbacks

Two separate things use the same OAuth client (`GOOGLE_CLIENT_ID`):

| Feature | What Google needs | Where in the code |
|---|---|---|
| **Sign in with Google** (Google Identity Services, ID-token flow) | the site's **origin** under *Authorized JavaScript origins* — no redirect URI | `src/server/auth/google-config.ts`, `verify-google-token.ts` |
| **Connect Gmail** (authorization-code flow) | the exact **redirect URI** under *Authorized redirect URIs* | `src/app/api/auth/gmail/callback/route.ts`; URI built from `APP_BASE_URL` by `getGmailRedirectUri()` |

Check in **Google Cloud Console → APIs & Services → Credentials → the OAuth 2.0 Client ID** (cannot be done from this repository):

* **Authorized JavaScript origins** contains exactly `https://www.compass-tools.com`
* **Authorized redirect URIs** contains exactly `https://www.compass-tools.com/api/auth/gmail/callback`
* The apex (`https://compass-tools.com/...`) is **not** registered as the callback (Google would send the browser to the apex, the apex would
  redirect to `www`, and the host-scoped `gmail_oauth_state` cookie would not follow — the CSRF check fails; see DEPLOYMENT.md §2a).
* **OAuth consent screen → Authorized domains** lists `compass-tools.com`.
* While you still run the old host in parallel, keep its entries; remove them after cut-over.

The callback **path is unchanged** by this deployment. `APP_BASE_URL` must be the same `https://www.compass-tools.com` in `.env`.

After cut-over, test both: sign in with Google, then **Connect Gmail** from your profile — a `redirect_uri_mismatch` or *"compass-tools.com
is blocked"* page means the redirect-URI list is wrong (DEPLOYMENT.md §2a has the case study).

## 9. HTTPS, proxy and health verification

### 9.1 Cloudflare settings to check manually (zone `compass-tools.com`)

| Setting | Where | Recommended | Why |
|---|---|---|---|
| Encryption mode | SSL/TLS → Overview | **Full (strict)** (or Automatic) | For a tunnel route to an HTTP origin the zone mode does not change the local connection (Cloudflare docs, "Troubleshoot HTTPS origins"), but a strict mode protects any *other* proxied hostname in the zone. **Do not** choose *Flexible* to "fix" anything. |
| Always Use HTTPS | SSL/TLS → Edge Certificates | **On** | HTTP → HTTPS at the edge. Cloudflare recommends redirecting at the edge, not the origin — the app does not, so there is no loop. |
| Minimum TLS version | SSL/TLS → Edge Certificates | **1.2** | |
| Automatic HTTPS Rewrites | SSL/TLS → Edge Certificates | On | Fixes accidental `http://` links in HTML. |
| HSTS | SSL/TLS → Edge Certificates | leave **off** at Cloudflare | The app already sends `Strict-Transport-Security: max-age=63072000` (no `includeSubDomains`/`preload`, deliberately). Two sources would conflict. |
| Redirect rule | Rules → Redirect Rules | apex → `www` (§7) | |
| WAF | Security → WAF | optional rule: **block** requests whose path starts with `/api/cron/` | These are authenticated, but nothing legitimate calls them from the internet — the scheduler uses the internal address. Cheap defence in depth. |

### 9.2 What the app assumes about the proxy (verified by running the production build)

* The app does **no** HTTP→HTTPS redirect, so Cloudflare terminating TLS cannot create a loop.
* Redirects the app issues are **relative** (`Location: /login`), identical with or without `X-Forwarded-Proto` — there is no scheme or host
  to get wrong behind the tunnel.
* Session and OAuth-state cookies are `Secure` in production; the browser always sees HTTPS.
* Client IP comes **only** from `CF-Connecting-IP` (`TRUSTED_PROXY=cloudflare`); `X-Forwarded-For` and `Forwarded` are never read in this mode.
* Server Actions compare the request's `Origin` with `Host`; `cloudflared` forwards the original `Host`, so they are expected to match. This one was **not** exercised end-to-end here — the manual check in §9.3 (save a record after signing in) confirms it.

### 9.3 Verify after every deployment

```bash
bash deploy/verify.sh               # containers, no published ports, app health, schema, upload storage, CVV job, and the public site via Cloudflare
bash deploy/verify.sh --internal    # skip the checks that go out through Cloudflare
```

It reports (and exits non-zero on failures): container health; **no host port published** and nothing listening on 5432/3000 beyond
loopback; `/api/health` → database OK, `schema=current`, `databaseTls=disabled`; the card vault state (a closed vault is a **warning**, not
a failure — it is the owner's opt-in); the **upload storage** (`uploadStorage=ready`, a write/read/delete probe as the app user, a host
bind mount, not visible to the database container, host disk below 80 % used); the last CVV cleanup; and, publicly, `/api/health` → 200, HSTS present, `http://` → `https://`,
an **unauthenticated `POST /api/cron/cvv-cleanup` is refused**, and `compass-tools.com` → `www`.

Also by hand, once: sign in with Google; open **System Health**; save any record (proves Server Actions work through the tunnel);
connect Gmail.

## 10. Daily CVV cleanup

### 10.1 What is guaranteed regardless of this job

The 24-hour limit is enforced by the application and the database, **not** by the scheduler: an expired code is never revealed (the reveal
path refuses and destroys it), the lifetime is fixed at exactly 24 hours after the signed form, and destruction also happens early on
confirmed payment, cancellation, card removal and administrative destruction (CARD_VAULT_SECURITY.md §19). The scheduled job removes
**already-unreadable** rows from the live database. A missed run is hygiene lag, not exposure. Nothing here changes or adds a retention
period.

### 10.2 How it is scheduled

* **Endpoint**: `POST /api/cron/cvv-cleanup` — does the CVV cleanup and **nothing else** (no notifications, no card-number purge, no other
  maintenance). Same `CRON_SECRET` bearer gate as every cron endpoint (503 in production without a secret, 401 for a wrong one, constant-time
  comparison). **POST only** — a link prefetch or crawler issuing `GET` gets 405. Returns 200 with the count, or **500 if the delete failed**
  (previously indistinguishable from "0 expired").
* **Scheduler**: the `cvv-cleanup` container runs `scripts/cvv-cleanup-scheduler.mjs`. It calls `http://app:3000` over the internal network
  (never through the internet), runs **once at 03:30 UTC daily**, plus a **catch-up run ~90 seconds after (re)start**. A failed attempt is
  retried after 1, 5 and 15 minutes. It logs one JSON line per attempt and never logs the secret.
* **Idempotent and retry-safe**: it deletes only rows already past `expiresAt`; running it twice, late, or after a failure cannot touch a valid
  code or move an expiry.
* **Observable**:
  ```bash
  docker compose logs --tail=20 cvv-cleanup            # {"job":"cvv-cleanup","status":"ok","destroyed":N,...}
  bash deploy/compose.sh run --rm cvv-cleanup node scripts/cvv-cleanup-scheduler.mjs --once    # run it right now (exit 0 = ok)
  ```
  The deletion itself is written to the audit log (`CVV_DESTROYED`, trigger `EXPIRED`). Set `CLEANUP_HEARTBEAT_URL` (for example a
  Healthchecks.io check with a 26-hour period) to be alerted if the job stops. `verify.sh` fails if the job has *given up*.

### 10.3 Daily maintenance (stale upload sweep) — a timer you install deliberately (decision 2)

Vercel Cron ran `/api/cron/tasks` daily. On the VPS:

* **Task-due notifications** are delivered by the in-process poller in `src/instrumentation.ts` (every 60 s, with an atomic
  `dueNotifiedAt` claim so duplicates are impossible).
* **`/api/cron/sequences`** and **`/api/cron/leads`** were never scheduled on Vercel either (sequence steps are processed from the UI; leads are
  distributed on creation).
* **The daily maintenance in `/api/cron/tasks`** deletes expired rate-limit counters and sweeps abandoned lead-document uploads (the
  partial file first, the record only once the file is gone; a completed attachment is never touched). Cancelled and failed uploads clean up
  immediately, so this only removes what a crash left behind — but without it those leftovers accumulate on the disk. It is idempotent.
  `deploy/run-daily-maintenance.sh` runs it from inside the app container (the secret never leaves the container). Run it by hand any time:
  ```bash
  bash deploy/run-daily-maintenance.sh
  ```
  and schedule it with the systemd timer shipped with the repository. **Nothing installs it for you** — you decide, on the VPS, as root:
  ```bash
  sudoedit deploy/systemd/compass-tools-maintenance.service    # check User= and the /opt/compass-tools paths first
  sudo cp deploy/systemd/compass-tools-maintenance.service deploy/systemd/compass-tools-maintenance.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now compass-tools-maintenance.timer
  systemctl list-timers compass-tools-maintenance.timer
  sudo systemctl start compass-tools-maintenance.service && journalctl -u compass-tools-maintenance.service -n 5 --no-pager   # try it now
  ```
  It runs at 03:30 UTC (after the 02:15 backup) and catches up after downtime. The same run also destroys any retained security code whose
  24-hour window has ended (the dedicated CVV job already does this; it is a second safety net), and the opt-in card-number purge stays
  **off** while `CARD_RETENTION_DAYS` is unset.

## 11. Logs and troubleshooting

```bash
docker compose ps                                  # state + health of every container
docker compose logs --tail=100 -f app              # application (errors carry a safe tag, never a card value or payload)
docker compose logs --tail=50 cloudflared cvv-cleanup db
docker compose exec -T app node scripts/healthcheck.mjs      # the same probe Docker uses
docker stats --no-stream                                     # memory / CPU against the limits
df -h / && docker system df                                  # disk
```

| Symptom | Look at |
|---|---|
| `Set X in .env` when starting | A required variable is empty (§2). |
| App container `unhealthy` | `docker compose logs app`; `/api/health` → `database.error` is a safe category (`ECONNREFUSED`, `53300`…). |
| *"The server does not support SSL connections"* | `DATABASE_SSL_MODE=disable` missing/ignored — compose sets it; check you did not override `DATABASE_URL` for the app. |
| *"DATABASE_SSL_MODE=disable is only allowed when DATABASE_URL is a valid URL whose host is exactly one of: db, localhost, 127.0.0.1, ::1 (and it sets no host= / hostaddr= parameter)…"* | The host in `DATABASE_URL` is not on that list (or the URL is empty/malformed, or carries `host=`/`hostaddr=`). For the Docker stack the host must be `db`: do not override `DATABASE_URL` for the app. If you are pointing the app at a remote database, remove `DATABASE_SSL_MODE` and use `DATABASE_SSL_CA` (§0.1) — plaintext is never accepted for it. |
| *"DATABASE_SSL_MODE=disable conflicts with DATABASE_SSL_CA / DATABASE_SSL_VERIFY…"* | Both a plaintext and a verified setting are present. Keep one: `disable` for the Docker `db`, the CA/verify settings for a remote database. |
| *"DATABASE_SSL_MODE must be "disable" (or unset)…"* | `DATABASE_SSL_MODE` holds any other value (`off`, `false`, `require`, …). Use exactly `disable` or leave it unset. |
| Site shows Cloudflare **1033 / 502** | `cloudflared` not connected (`docker compose logs cloudflared`; token wrong/rotated) or the route points at the wrong service (must be `app:3000`). |
| Redirect loop | A rule redirecting at both Cloudflare **and** the app, or *Flexible* mode with an origin redirect. The app itself never redirects http→https. |
| `redirect_uri_mismatch` / "blocked" on Connect Gmail | §8. |
| Build killed / `JavaScript heap out of memory` | Add swap (§3.2); build when idle: `docker compose build app`. |
| Signer IP missing on bookings | `TRUSTED_PROXY`/`CF-Connecting-IP`: System Health → *Signer IP capture*. |
| Out of disk | `docker image prune -f`, old backups in `/var/backups/compass-tools`, `docker system df`. |

## 12. PostgreSQL backup and restore

> **Lead documents are not in the database.** The database holds only their metadata; the files are on the VPS disk
> (`/srv/compass-tools/uploads`). `deploy/backup-uploads.sh` backs them up (the systemd unit runs it right after the database dump) and
> `deploy/restore-uploads.sh` restores them. Always restore both from the same day: `docs/LEAD_ATTACHMENTS.md`, "Backup and restore".

### 12.1 What a backup contains

`deploy/backup-db.sh` writes a `pg_dump --format=custom` file with:

* **everything** the application stores, including the **encrypted** card numbers, Gmail refresh-token ciphertext, IP-vault ciphertext and
  all personal data → *a backup is exactly as sensitive as the database*;
* **not** the data of the `PaymentMethodCvv` table. Retained security codes are destroyed 24 h after the signed form; a backup that kept them
  would keep them as long as the backup lives. The script verifies (`pg_restore --list`) that the file is readable **and** that no CVV data
  is in it, and refuses to keep it otherwise. A restore therefore comes back with no retained codes (they would have expired within a day).
* **not** the uploaded Lead documents (see the note above) — they are backed up as a separate archive;
* **not** the encryption keys — those live only in `.env`. **A backup without the keys is unusable; keys without a backup are useless.** Keep
  both, separately.

### 12.2 Daily schedule (systemd timer)

```bash
sudo cp deploy/systemd/compass-tools-backup.* /etc/systemd/system/
sudoedit /etc/systemd/system/compass-tools-backup.service     # check User=, WorkingDirectory=, paths
sudo systemctl daemon-reload && sudo systemctl enable --now compass-tools-backup.timer
systemctl list-timers compass-tools-backup.timer
sudo systemctl start compass-tools-backup.service && journalctl -u compass-tools-backup.service -n 20 --no-pager   # try it now
```

Runs at 02:15 UTC (`Persistent=true` catches up after downtime), keeps 14 days (`KEEP_DAYS`), files are `600` in a `700` directory.
A failed run shows in `systemctl status compass-tools-backup.service`. **RPO is up to 24 hours** (a logical dump once a day, no WAL
archiving / point-in-time recovery).

### 12.3 Off-server copy (decision 4) — encrypted only

A backup that lives only on the VPS is lost with the VPS. Encrypt before it leaves the server, with a public key whose private half is kept
**off** the server:

```bash
age-keygen -o ~/compass-backup-key.txt          # run on YOUR computer; keep this file in a password manager, not on the VPS
# put the printed "age1…" public key into the service:  Environment=BACKUP_AGE_RECIPIENT=age1…
```

With `BACKUP_AGE_RECIPIENT` set the script writes `*.dump.age` and deletes the plaintext (and **fails** rather than leave a plaintext copy if
`age` is missing). Then copy the `.age` files off-box (`rclone`/`scp` to storage you control).

### 12.4 Restore — practise it

```bash
# 1. TEST restore into a throw-away database; the live site is untouched. Do this monthly.
bash deploy/restore-db.sh /var/backups/compass-tools/compass-<timestamp>.dump

# 2. REPLACE the live database (destructive: offline during the restore; asks you to type the database name;
#    takes a fresh safety backup first):
bash deploy/restore-db.sh /var/backups/compass-tools/compass-<timestamp>.dump --replace
```

Encrypted backups: `age -d -i ~/compass-backup-key.txt file.dump.age > file.dump` first. After a restore, run `deploy/verify.sh`. Restoring an
**old** backup needs the key ring that was current when it was taken (CARD_VAULT_SECURITY.md §6, §10).

### 12.5 Downloading a backup from the CRM (Admin → Database Backup)

Admins have a **Database Backup** entry in the sidebar (`/database-backup`) with one button, **Download Database Backup**. It is a convenience for taking
a copy to your own computer; it does **not** replace the scheduled timer in §12.2 (nobody has to remember to click it).

* **Who:** Admins only, checked on the server for the page, the Server Actions and the download endpoint (not just hidden in the menu). Creating a
  backup also needs a sign-in within the last 15 minutes. Every create, download, delete and refusal is written to the audit log (no connection
  string, password or path is ever logged).
* **What it runs:** `pg_dump --format=custom --compress=6 --no-owner --no-privileges --exclude-table-data=PaymentMethodCvv`, started without a
  shell, against the `DATABASE_URL` the app already uses (the password goes to the tool in an environment variable, never on a command line).
  It is the same format and the same CVV exclusion as `deploy/backup-db.sh`, so `deploy/restore-db.sh` reads both.
* **Checked before it is offered:** the dump is written to a `.partial` file, read back with `pg_restore --list` (it must contain the `Account`
  table and `_prisma_migrations` and must **not** contain `PaymentMethodCvv` data), then renamed and given a SHA-256. A failed or timed-out dump is
  deleted and nothing is offered. The page shows time, size, format, status and the SHA-256 so you can check the copy you downloaded.
* **Safe by construction:** one backup at a time (lock file), a 30-minute limit, a free-disk check before starting, the file is streamed (never held in
  memory), the staged copy is removed after a complete download (or after 60 minutes), and the file name is a generated id that is matched against an
  exact pattern, so no path can be supplied.
* **Where it is staged:** the `backup_staging` Docker volume (`/var/lib/compass-tools/backups`, mode 0700, owned by the app user). The image carries
  the PostgreSQL **17** client (`postgresql-client-17`, from the PostgreSQL apt repository) because `pg_dump` must be the same major version as the
  server or newer. If you change the `db` image to a newer major, change `postgresql-client-17` in the `Dockerfile` to match and rebuild.
* **Not an in-app restore.** A button that can overwrite the live database from the website is a larger risk than the convenience is worth. Restoring
  is the deliberate, typed-confirmation procedure in §12.4 / §12.6, run by someone with server access.
* **Sensitive:** the file holds all customer data and the *encrypted* card numbers. Store it encrypted (`age -r <public key> file.dump`) and outside
  this server; delete old copies.

### 12.6 Rebuilding on a replacement VPS (disaster recovery)

A database backup is one of **five** things you need. Keep all of them, separately, off the server:

| # | What | Where it comes from |
|---|---|---|
| 1 | Database dump (`.dump`) | §12.2 timer / Admin → Database Backup |
| 2 | `.env` (all keys: `CARD_ENCRYPTION_KEY` key ring, `GMAIL_TOKEN_ENCRYPTION_KEY`, `IP_ENCRYPTION_KEY`, `IP_HASH_KEY`, `CRON_SECRET`, `LEAD_INGEST_SECRET`, `POSTGRES_PASSWORD`, `GOOGLE_*`, `APP_BASE_URL`, …) | your password manager. **Without the keys the encrypted card numbers, Gmail connections and IP vault in the dump cannot be read.** |
| 3 | Uploaded lead documents | `deploy/backup-uploads.sh` archive (`docs/LEAD_ATTACHMENTS.md`) |
| 4 | Cloudflare Tunnel token / DNS / Google Cloud OAuth client | Cloudflare and Google consoles (not in any backup). The Google client needs this deployment's origin and the Gmail redirect URI (§8). |
| 5 | The code | this Git repository (the release branch / commit that was running) |

Steps (the database part is tested; see "What has and has not been tested" below):

1. Provision the VPS and do §3 (user, swap, Docker). Point nothing at it yet.
2. `git clone` the repository to `/opt/compass-tools` and check out the release commit that was running.
3. Restore `.env` from your password manager (mode 600). Do **not** generate new keys.
4. Restore uploads into `/srv/compass-tools/uploads` (`deploy/restore-uploads.sh <archive>`).
5. Start only the database: `docker compose up -d db` and wait for it to be healthy. This creates an empty database with the `POSTGRES_*` user.
6. Check the file first: `sha256sum compass-….dump` must equal the SHA-256 shown when it was made; `pg_restore --list compass-….dump | head`.
7. Restore into a throw-away database to prove it, then into the real one:
   ```bash
   bash deploy/restore-db.sh /path/compass-….dump               # test restore, prints row counts, drops the copy
   bash deploy/restore-db.sh /path/compass-….dump --replace     # type the database name; stops the app, takes a safety backup, restores
   ```
   `--replace` works on a brand-new empty database **since 2026-11-24**. Before that it did **not**: it takes a safety backup of the current database first, and `backup-db.sh` deliberately refuses a dump without the `Account` table, so on a fresh server the restore stopped after stopping the app. It now skips the safety backup, and says so, only when the database has no CRM tables. It restores with `--no-owner`, so objects belong to the `POSTGRES_USER` the app uses.
   There are **no custom roles, extensions or grants** in this schema (`prisma/migrations` contains none), so nothing has to be recreated.
8. Apply migrations that were added after the backup, if any: `bash deploy/deploy.sh --migrate`. A backup taken from the running release is already
   at that release's schema (`prisma migrate status` reports "up to date").
9. Bring the stack up (`bash deploy/deploy.sh`), then `bash deploy/verify.sh`, sign in as an Admin, open a lead, a booking and **System Health**.
   Re-point the Cloudflare Tunnel / DNS only after this works.

**Version compatibility.** Restore into the same PostgreSQL major version or newer (a custom-format dump from 17 restores into 17 or later, not
into 16). `pg_restore` must be the same major version as the dump or newer. The compose file pins `postgres:17.11-bookworm`.

**What the restore does *not* bring back, by design:** retained card security codes (never backed up), upload files (step 4), secrets (step 3),
Cloudflare/Google/DNS settings (step 4 of the table), sessions (users sign in again), and anything created after the backup was taken.

**What has and has not been tested.** The dump → verify → restore-into-a-new-database path, including a table-by-table row/content comparison,
index/constraint/sequence comparison and `prisma migrate status`, is covered by an integration test that runs a real `pg_dump`/`pg_restore` 17.11
against a disposable PostgreSQL 17.11 (`src/server/backup/__integration__/database-backup.integration.test.ts`; skipped unless
`INTEGRATION_DATABASE_URL`, `INTEGRATION_ADMIN_DATABASE_URL`, `PG_DUMP_BIN` and `PG_RESTORE_BIN` are set). It was **not** run on a replacement VPS or
through `deploy/restore-db.sh` inside Docker (Docker was not available where this was developed). The CI smoke test (`deploy/ci-smoke.sh`, last step) now rehearses it on real Docker: it
takes a dump with the app image's own `pg_dump`, runs `restore-db.sh` in test mode, empties the database, runs `restore-db.sh --replace` with the typed confirmation, and checks that the
Account table, the migration history and a healthy app are back - **that step has not been run yet** (it runs the first time CI does). The `--replace` logic change was checked by reading the
script and by running its shell quoting against a stand-in. Do a full rehearsal on a spare VPS before you depend on this, and repeat it after any change to the database image.

**Browser-level check (2026-11-24, production build, PostgreSQL 17.11 on Windows, seeded demo data; reported item by item so nothing is overstated):**

| Item | Result |
|---|---|
| Database backup created by the real **Download Database Backup** button as an Admin | **Done.** Created, verified and offered (611 KB); a sign-in older than 15 minutes was correctly refused first. |
| Browser download | **Done.** The browser requested `/api/admin/database-backup/<id>` and received 625,904 bytes (a temporary file in the browser's download folder). A second run captured the real response: `200`, `Content-Disposition: attachment; filename="compass-<UTC time>-<id>.dump"`, `application/octet-stream`, `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`, `X-Content-Type-Options: nosniff`, chunked, first bytes `PGDMP`, and a SHA-256 computed from the received bytes **equal** to the `X-Backup-SHA256` header. A second request for the same id: `404` (the staged copy is removed after a complete download); anonymous: `401`; path-traversal ids: `401`/`404`; the staging folder was empty afterwards. |
| The **downloaded** file read back | **Done.** `pg_restore --list` on the browser-received file succeeded (497 entries, custom format, dumped from 17.11 by pg_dump 17.11); `PaymentMethodCvv` has its table, constraint, index and foreign key but **no data entry**. |
| The downloaded file restored into a brand-new database | **Done.** `pg_restore --exit-on-error` exit 0; 57/57 tables, 228 indexes, 164 constraints, 3 sequences with identical values, 1 trigger (`AuditLog` append-only) and 1 function, 6 accounts, 82 migrations and a checksum over accounts and leads were identical; the only row differences were the 2 audit rows and 1 rate-limit counter written *after* the dump. `prisma migrate status` on the restored database: "Database schema is up to date!". A second app instance started against the restored database let the same Admin in and listed all 12 leads. (The dump has no views; the application defines none.) |
| Restore inside **Docker** (`deploy/restore-db.sh`, test and `--replace`) | **Not run.** The script needs a Docker `db` container and Docker was not available. The equivalent `pg_restore` steps above were run by hand. |
| **Replacement-VPS** recovery (§12.6 end to end) | **Not run.** Needs a spare server. |

The release image's PostgreSQL apt key fingerprint (`B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8`) was re-derived on 2026-11-24 from the file postgresql.org serves (`ACCC4CF8.asc`) and matched. The download response has no `Content-Length` (it is streamed); compare the SHA-256 shown on the page, which the browser-computed value matched.

## 13. Routine updates from GitHub

1. Make and review the change in GitHub (feature branch → pull request → CI green → review → merge to `main`).
2. On the VPS, at a quiet time:
   ```bash
   cd /opt/compass-tools
   bash deploy/deploy.sh                 # shows what changes, builds, checks migrations, restarts, verifies
   bash deploy/deploy.sh --migrate       # same, and applies pending migrations (backup first)
   ```
3. If anything in `verify.sh` fails, roll back (§14). A deployment that is merely *different* (e.g. new commit shown by `git log`) is not proof
   it works — the script's verification and your own check of sign-in + one real action are.

The VPS must stay a **clean checkout**: do not edit files there. If you must (an emergency), commit the same change in GitHub afterwards;
`deploy.sh` refuses to run over uncommitted changes rather than discard them.

## 14. Rollback

```bash
docker images compass-tools --format '{{.Tag}}   {{.CreatedAt}}'       # versions still on this server (the 5 newest are kept)
bash deploy/rollback.sh <version>                                       # restarts app + cvv-cleanup on that image, then verifies
```

* No rebuild, no data change. Takes seconds.
* It does **not** undo migrations (forward-only). Usually the older code runs fine on a newer, additive schema. If `verify.sh` complains, or
  the release notes say a migration changed/removed something, restore the pre-deploy backup instead (§12.4) — `deploy.sh --migrate` took one.
* If the old image was pruned, `bash deploy/deploy.sh --ref <sha>` rebuilds it (only commits already on `origin/main` are accepted) - or, for a
  commit of a release branch, `bash deploy/deploy.sh --release-branch release/<name> --ref <full 40-character sha>` (§19.7).
* If the **tunnel** is the problem, nothing to roll back: `docker compose restart cloudflared`, or check the token (§15).

## 15. Secret rotation and recovery

| Secret | How to rotate | Consequence / warning |
|---|---|---|
| `CRON_SECRET` | New value in `.env` → `bash deploy/compose.sh up -d app cvv-cleanup` | Safe, instant. Both containers read the same variable. |
| `TUNNEL_TOKEN` | Dashboard → the tunnel → refresh/rotate the token; new value in `.env` → `bash deploy/compose.sh up -d cloudflared` | Brief tunnel interruption. Do this if the token may have been exposed. |
| `POSTGRES_PASSWORD` | `docker compose exec db psql -U compass -c "ALTER USER compass PASSWORD '<new>'"` (use a hex value), then edit `.env`, then `docker compose up -d` | Editing `.env` **alone does nothing** to an existing database. |
| `GOOGLE_CLIENT_SECRET` | Google Cloud → create a new secret → `.env` → `bash deploy/compose.sh up -d app` → delete the old secret | Sign-in uses the client **ID**; the secret matters for Connect Gmail. |
| `CARD_ENCRYPTION_KEY` | **Never replace.** Add a new key to the key ring and re-encrypt: CARD_VAULT_SECURITY.md §6 (`bash deploy/compose.sh run --rm tools npm run cards:rotate`) | Replacing the value destroys access to every stored card. Keep every old key while any backup or card uses it. |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | No rotation mechanism. A new value makes stored Gmail tokens unreadable → every user must reconnect Gmail | Only after confirmed compromise (DEPLOYMENT.md §5e). |
| `IP_ENCRYPTION_KEY`, `IP_HASH_KEY` | No rotation mechanism; a new value makes existing IP records unreadable / unsearchable | Manual migration only (docs/ip-vault-compliance.md). |
| `LEAD_INGEST_SECRET` | Create the new credential at the source, update `.env`, restart `app`, then revoke the old | `LEAD_INGEST_SECRET` must match the travel website. |

After any `.env` change: `bash deploy/compose.sh up -d` (Compose recreates only the services whose environment changed), then `bash deploy/verify.sh`. Use `deploy/compose.sh`, not a bare `docker compose up`: in a fresh shell `APP_VERSION` is unset, and a bare command would look for (and try to build) an image called `compass-tools:local` instead of the version that is deployed.

**Recovery from server loss**: new VPS → §3 → clone → restore `.env` from your off-server copy → `docker compose up -d db` → restore the latest
backup (§12.4) → `bash deploy/deploy.sh` → §9.3. Tunnel and DNS need no change: the tunnel is outbound-only, so a new connector with the same
token takes over. **If `.env` (the keys) is lost, the encrypted data in every backup is unrecoverable.**

If a secret may have been exposed: rotate it (table), review the audit log (Admin → audit) for unexpected card reveals, and follow
CARD_VAULT_SECURITY.md §6 "Suspected key compromise".

## 16. Known limitations and security / compliance warnings

### 16.1 This is not PCI DSS compliance

The owner has chosen the application's own card vault to collect card details so staff can arrange supplier payments manually. This
deployment **does not make that compliant** and nothing in this repository claims it. It stores full card numbers (AES-256-GCM,
application-managed keys, no HSM/KMS, no dual control) and, for 24 hours, the security code. The remaining risks are listed in
CARD_VAULT_SECURITY.md §13 and §19.7 and **require QSA/acquirer review**. In particular on this deployment:

* **Encryption-key management**: the keys are in `.env` on the same server as the database. Anyone with root on the VPS, or with the `docker`
  group, can read both and decrypt every card. Treat server access as access to the vault.
* **Privileged staff access**: Admin Reveal is separately granted and needs a recent sign-in, but a staff member with a compromised Google
  account at that moment is still a path. Keep Admin accounts few, use Google 2-step verification, review the audit log.
* **Backups**: contain encrypted card numbers (and personal data); see §12.1. Copies must be encrypted and access-controlled.
* **Audit-log integrity**: the log is append-only at the database level, but a database superuser (anyone with root on the VPS) can alter it.
* **The vault is closed by default** (`CARD_VAULT_MODE` unset). Customers cannot complete a booking that needs card storage until the owner
  opts in. No file here opens it.
* **`CARD_RETENTION_DAYS` is unset**: card numbers are kept until removed by an Admin. That is a business decision this repository does not
  make.

### 16.2 Operational limitations of a single VPS

* One server, one disk, one database: no high availability, no automatic failover, **RPO ≈ 24 h**, RTO = the time to rebuild (§15).
* Containers do not update themselves: you patch the OS (`unattended-upgrades` covers security updates), rebuild the app, and bump the
  pinned images (§18). Docker restarts crashed containers (`restart: unless-stopped`) but not unhealthy ones.
* The image build needs ≈ 3 GB of memory (swap helps) and takes a few minutes; the site keeps serving the old container while it builds, but
  keep the build off peak hours.
* `/api/health` is public (as on Vercel) and exposes readiness *categories* only (no hosts, keys, or values). Block it in Cloudflare WAF
  if you do not use an external monitor.
* Approximate visitor **location** (city/region/country) is not captured (it relies on Vercel's edge headers); the IP is.

### 16.3 OVHcloud snapshots and automated backups (decision 3)

A VPS snapshot or "automated backup" copies the **entire disk**: the PostgreSQL volume *and* `/opt/compass-tools/.env` (the keys). It also copies the **uploaded Lead documents** (passport copies and similar) in `/srv/compass-tools/uploads` unless that directory is on a separate volume. It
therefore contains decryptable card data and — for snapshots taken inside the 24-hour window — retained security codes, and it is kept for
the provider's retention period. If you enable these, treat the snapshots as part of the vault's PCI scope, or keep the database on a
separate encrypted volume. This guide's own backup excludes the CVV table; a disk snapshot does not.

## 17. Moving existing data from the current database

The Docker stack starts **empty**. To bring the existing data across (high-impact — plan a window; this is decision 1):

1. Put the CRM into a read-only state for staff (announce a window), so nothing is written during the copy.
2. On the VPS, with the **same keys** already in `.env` (§2), start only the database and apply the schema: `docker compose up -d db` then
   `docker compose run --rm tools npx prisma migrate deploy`. (On a brand-new server no version is installed yet, so this builds the image untagged; `bash deploy/deploy.sh --migrate` does the same with a proper version tag and is the preferred route.)
3. Check the source server version: `SHOW server_version;` — the client used for the dump must be the same major version or newer
   (this stack runs 17). Dump **without** the CVV data (those codes expire within a day):
   ```bash
   # Run from the VPS. The source URL is typed on the command line only for this run; do not save it in a file or shell history you share.
   read -rs SRC_URL; export SRC_URL
   docker run --rm -e SRC_URL postgres:17.11-bookworm sh -c \
     'pg_dump "$SRC_URL" --format=custom --no-owner --exclude-table-data="\"PaymentMethodCvv\""' > /tmp/source.dump
   ```
4. Restore into an **empty** database and check it before switching traffic: use the test-restore path first
   (`bash deploy/restore-db.sh /tmp/source.dump` → counts), then `--replace` to load it into the live database. Delete `/tmp/source.dump`.
5. `bash deploy/deploy.sh`, `bash deploy/verify.sh`, sign in, open a recent lead/quote/booking, confirm Gmail still sends (tokens decrypt only
   with the unchanged `GMAIL_TOKEN_ENCRYPTION_KEY`) and a stored card can be listed.
6. Switch DNS/tunnel routes (§6–7) and update Google (§8). Keep the old host untouched and in read-only mode until you are satisfied; it is
   your rollback.

Sessions: signing in again is expected after the move.

## 18. Updating base images, and the dependency audit

### 18.1 Pinned images and the update policy

`compose.yaml` and the `Dockerfile` pin each base image by **version and digest** so a rebuild or restart can never silently change it
(digests were read from Docker Hub on 2026-10-13):

| Image | Pin | Update |
|---|---|---|
| Node | `node:24.21.0-bookworm-slim@sha256:d6aa754f…` | Monthly, or on a Node security release. Bookworm is supported until mid-2028. |
| PostgreSQL | `postgres:17.11-bookworm@sha256:3645570c…` | **Minor** releases: bump and `docker compose up -d db` (restarts the database briefly). **Major** upgrades (17 → 18) need a dump/restore into a new volume — never just change the tag. |
| cloudflared | `cloudflare/cloudflared:2026.10.0@sha256:9b49eed8…` | Keep within a few releases of current; Cloudflare supports recent versions only. |

To update one: look up the new tag and digest (`docker buildx imagetools inspect <image>:<tag>`), change the pin in one commit, let CI run
the Docker smoke test, merge, deploy. The trade-off of pinning: you must do this on purpose, but you never get a surprise change.

### 18.2 `npm audit` (state on 2026-10-13: 59 findings — 1 critical, 25 high, 33 moderate)

Reported by CI on every run (`audit` job, non-blocking). **No `npm audit fix --force` was run and no dependency was changed by this work.**
Many "fixes" npm suggests are nonsensical downgrades (e.g. `prisma@6.19.3`, `eslint-config-next@14`, `shadcn@1.0.0`) — ignore those.

| Class | Packages | Reaches users or the server in production? | What to do |
|---|---|---|---|
| **Shipped in the app** | `nodemailer` 9.0.5 (high ×2, moderate: recipient-domain parsing, address-parser DoS, DNS-cache servername reuse) | **Yes** (server bundle; all outgoing mail). Needs **10.x** (≥ 10.0.6) — a **major** bump. | Own PR: upgrade to the current 10.x, run the email unit/integration tests, send test mail through each connected Gmail account and a quote-confirmation email. **Highest priority.** |
| **Shipped in the app** | `@tiptap/*` 3.30.2, `prosemirror-view` 1.42.2 (high: paste-handling XSS, Markdown-attribute ReDoS; moderate: prototype key) | **Yes** (browser editor, authenticated staff only). Fixes are **minor/patch** within the current majors (`@tiptap/*` ≥ 3.30.5, `prosemirror-view` ≥ 1.42.3). | Own PR: `npm update @tiptap/core @tiptap/react @tiptap/starter-kit @tiptap/extension-image @tiptap/extension-link prosemirror-view`, run the tests, exercise the template editor (paste, links, images). |
| Cloudflare Workers build only | `@opennextjs/cloudflare`, `@opennextjs/aws`, `glob`, `@node-minify/core`, `express` → **`proxy-addr` (the one critical)** | **No** — build tooling; not in the Docker image or the VPS runtime. | Handled with the Workers work (CLOUDFLARE_DEPLOYMENT.md). |
| CLI / dev tooling | `shadcn` (→ `@modelcontextprotocol/sdk`, `fast-glob`, `braces`, `micromatch`, `ts-morph`, `qs`, `hono`, `ip-address`), `prisma` CLI (`@prisma/config`, `deepmerge-ts`, `mysql2`), `eslint-config-next`, `vitest`, `jsdom`→`undici`, `js-yaml`, `fast-uri`, `brace-expansion`, `source-map-js` | **No** — run at build/dev time or by an operator on trusted input; the `tools` container has no internet. | Check whether `shadcn` (a CLI, currently listed under `dependencies`) can move to `devDependencies`; update the rest when convenient; no production urgency. |

Compatibility testing any upgrade needs: `npx tsc --noEmit`, `npm run lint`, the full suite (`npx vitest run --no-file-parallelism`, with the
integration database as CI does), `bash deploy/ci-smoke.sh` on a Linux/Docker host (or just open the PR — CI runs it), and a manual pass over
email sending and the template editor.

## 19. Release 2026-11-20 (failed sign-ins, customer email privacy, subscriptions and queued campaigns) - redeployment checklist

Everything here uses the scripts and sections above; nothing new is invented. **Commands marked LOCAL are safe on a developer machine. Commands marked PRODUCTION change the VPS and must only be run by the owner, at a quiet time, with a backup.** This task did **not** deploy, migrate or restart anything.

### 19.1 What ships, and the order that matters

* **Release path.** There are now two deliberate paths, both manual (a push never deploys anything; `deploy.sh` also refuses a checkout with uncommitted changes):
  * **Release branch (no merge into `main`) - section 19.7.** The approved work lives on the dedicated branch `release/compass-tools-2026-11-22` (it contains the whole history of `review/crm-verification-2026-11-13` plus the later commits; `main` is not changed and nothing is merged into it). CI (`.github/workflows/ci.yml`) runs on every push to a `release/**` branch: **`npm ci`, `prisma migrate deploy` on an empty PostgreSQL, `deploy/check-migration-drift.sh`, and `npx vitest run --no-file-parallelism` WITH the database-backed suites enabled**, plus the Docker smoke test. On the VPS: `bash deploy/deploy.sh --release-branch release/compass-tools-2026-11-22 --ref <the FULL 40-character commit id that was approved> --migrate` (19.7 lists exactly what is checked first).
  * **Via `main` (unchanged).** `deploy.sh` without `--release-branch` still requires `git merge-base --is-ancestor <target> origin/main`: open a pull request to `main`, CI green, review, merge, then `bash deploy/deploy.sh --migrate` (19.3).
  * Earlier versions of this guide said the CI workflow ran on every push; it ran only for pull requests and pushes to `main` / `feature/**`. `release/**` was added for the release branch (nothing else about the workflow changed: read-only permissions, SHA-pinned actions, no secrets, no deploy job).
* **One additive migration**: `20261120000100_security_privacy_marketing_scale` (new tables, new defaulted columns, new enum values, indexes; no column, row or constraint is changed or removed; `Account.unlimitedCustomerEmailAccess` defaults to FALSE so nobody gains access). It was generated offline and has **not been rehearsed on PostgreSQL**: do the rehearsal in 19.2 first. `20261115000100_account_contact_detail_edit_permission` (the contact-edit permission, default TRUE) is also pending if the server is still on an older release.
* Order: backup -> migration (`--migrate`) -> new app image -> verify. Never start the new application image on the old schema: the new code reads the new tables and columns (the privacy layer fails closed - everything masked - if it cannot read them, but the failed sign-in log, imports and campaigns need the schema).
* The background jobs (`sequences`, `tasks`, `campaigns`) run inside the app process (the in-process poller). **Run ONE app instance.** The claims are row-level conditional updates that are designed to be safe across instances, but that has not been demonstrated on PostgreSQL. To stop all background work: set `DISABLE_IN_PROCESS_POLLER=true` and restart (sequence mail then needs `deploy/run-sequence-sweep.sh`; imports and campaigns simply wait).

### 19.2 Before production (LOCAL / disposable database only)

1. `npx tsc --noEmit`, `npm run lint`, `npx vitest run` (expected: only database-gated files skip).
2. **Database gate (mandatory before the merge).** The safest and approved place is the CI `tests` job, which starts a throw-away `postgres:17` with TLS (in the runner's own network namespace, listening on 127.0.0.1 only, which a workflow step verifies - a database reached through a published Docker port is refused by the test gate because its server address is a container address), applies every migration to the empty database, checks migration drift, and runs the whole suite including the files that skip locally. To run the same on a machine, it needs an **approved, disposable** PostgreSQL on loopback with a database named exactly `compass_test` (`src/test/disposable-database.ts` and `src/test/integration-database-guard.ts` refuse anything else and also ask the server which database it reached). Nothing on the developer machine this release was prepared on provides one (no PostgreSQL, no Docker), so this gate has **not been run**:
   ```bash
   # with the approved disposable database running and migrated (prisma migrate deploy against THAT database only):
   INTEGRATION_DATABASE_URL="postgresql://<user>:<password>@127.0.0.1:<port>/compass_test?sslmode=<mode>" npx vitest run
   ```
   The files that matter for this release: `src/server/actions/__integration__/customer-email-privacy.integration.test.ts` (twenty concurrent reveals admit exactly five; same-customer reveals cost one; a refused reveal leaves no record) and the sequence claim tests.
3. `bash deploy/ci-smoke.sh` on a Linux/Docker host (or open the PR: CI runs it). The Docker image build has not been run for this release.

### 19.3 Production steps (PRODUCTION - owner only)

```bash
cd /opt/compass-tools
bash deploy/backup-db.sh                  # explicit backup first (also taken automatically by --migrate when tables exist)
bash deploy/deploy.sh --migrate           # shows incoming commits and migration files, asks to confirm; backup; migrate; build; start; verify
bash deploy/verify.sh                     # §9.3
```

Required environment (unchanged names; `.env` is mode 600; **secrets**: `DATABASE_URL`, `CRON_SECRET`, `GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `CARD_ENCRYPTION_KEY`, `IP_ENCRYPTION_KEY`, `IP_HASH_KEY`, `LEAD_INGEST_SECRET`, `WEBSITE_API_KEY`). Website signing (names only; values are secrets or switches, never written here): `LEAD_INGEST_SECRET` (must equal the website's value), `WEBSITE_SIGNATURE_REQUIRED` (leave UNSET for the CRM-first deployment; set to `true` only after the updated website is live), `LEAD_INGEST_SECRET_PREVIOUS` (only during a key rotation). Optional new settings (listed in `.env.example`), with defaults if unset: `CAMPAIGN_SENDS_PER_MINUTE` (20), `CAMPAIGN_DAILY_LIMIT` (400, per sending Gmail account per rolling 24 hours). Do not raise them without checking the sending account's real Gmail limit. `TRUSTED_PROXY` must be correct for the failed-sign-in log to record the real client address (it records none when no trusted header exists).

### 19.4 Post-deployment smoke tests (after `verify.sh` passes)

1. **Health**: `/api/health` reports `schema=current`. Open **System Health**: "Automatic sequence sending" is Healthy a minute or two after start. The row "Campaign delivery" is Healthy after a minute or two as well (Unknown for the first minute after a start is normal; the former "Imports" row no longer exists).
2. **Background poller**: the log shows no `[sequence-sender]` or `[campaign-sender]` failure lines (they carry only an error category). A restart shows "Unknown" for about a minute, then Healthy.
3. **Failed sign-ins**: as an Administrator the sidebar shows **Failed Sign-ins** between Subscriptions and Users; as a non-administrator the item is absent and `/failed-signins` returns 404.
4. **Customer email privacy**: as a Travel Agent open a lead - the address is masked and has **no email edit pencil** (the phone pencil is unaffected), the counter reads "0 / 5 used this period", Reveal shows the complete address, the email pencil appears and the counter goes to 1; reload (still shown, still 1); open the same lead in a second browser (still 1). The period ends at **1:15 PM Pacific time** every day (also across daylight saving): after that the address is masked again, the pencil is gone and the counter is back to 0 - check this on the next day, or in a test with a controlled clock (the unit tests do). As an Administrator open the same lead (complete, no counter). On **Users**, "Unlimited Customer Email Access" is OFF for everyone except Administrators ("Always").
5. **Sequence delivery**: on a test lead with a test recipient, enroll one sequence and confirm one email; the lead and sequence pages show the same state.
6. **Subscriptions and campaign worker**: add a 3-line list with **Add Bulk Subscribers** (the CSV import was removed); build a campaign with the builder, **Send test to me** (arrives at your own address); queue it to a test audience of a few addresses you own; the **Delivery Status** list on the campaign page shows Waiting / Scheduled -> Sent at about 20 a minute (25 / 50 / 75 / 100 per page); the **Cancel** next to a waiting recipient stops just that one message; Pause stops the campaign between recipients, Resume continues, Cancel (campaign) is final. A campaign whose audience is exactly ONE subscriber is sent at once. **Do not queue a campaign to real subscribers as a test.**
7. **Staff notification privacy**: with a restricted Travel Agent as the new owner of a TEST lead, the "Lead Reassigned to You" / "New Flight Request" email shows "Hidden for privacy - open the record in the CRM and use Reveal" and has no mailto link or Reply button; the same email to an Administrator shows the address.
8. **Search**: as a Travel Agent type a customer's COMPLETE email address in the global search: the record is found and its address stays masked; a fragment of the address finds nothing; the same customer is found by phone number typed with spaces and brackets and by first, last and full name. **Subscriptions**: as a Marketing Agent without the unlimited switch the addresses are masked; typing one complete address finds it.
9. **Website signing (CRM first)**: with the CRM deployed and `WEBSITE_SIGNATURE_REQUIRED` unset the live website still delivers requests; after the updated website is deployed, one real inquiry shows its visitor IP and location in the CRM, then set `WEBSITE_SIGNATURE_REQUIRED=true`, restart, and confirm that an unsigned `curl` to the contact route is refused with 401.
10. **Unsubscribe header**: send ONE campaign to a test address you own (with approval) and check that Gmail shows its own "Unsubscribe" link for it (the `List-Unsubscribe` pair); do not test with real subscribers.
11. **Dependencies**: `npm audit` should report 9 advisories, none critical (see `DEPENDENCY_AUDIT_2026-11-22.md`); the Prisma 7.10.1 update is exercised by the database gate above and by every step of this list.

### 19.5 Rollback

* Application: `bash deploy/rollback.sh <version>` (§14). It does not undo migrations; the new schema is additive and the older image runs on it. If a migration is the problem, restore the pre-deploy backup (§12.4).
* Criteria to roll back: `verify.sh` fails; System Health stays Critical for the scheduler; a restricted user can see a complete customer address without a reveal; a Reveal consumes more than one allowance per customer per day; a campaign sends to an unsubscribed address or sends the same recipient twice.
* To stop an in-progress campaign without rolling back: **Pause** it from its page (takes effect between recipients), or set `DISABLE_IN_PROCESS_POLLER=true` and restart.

### 19.1a Migrations this release branch adds beyond `main` (apply in this order, all additive; NOT applied to any database by this work)

| Migration | What it does | Notes |
| --- | --- | --- |
| `20261108000100_sign_in_location_provenance` | columns for the source and time of a sign-in location | |
| `20261113000100_inquiry_submission_info` | the inquiry submission-info table | |
| `20261115000100_account_contact_detail_edit_permission` | `Account.canEditContactDetails`, default true | existing rows keep the ability they had |
| `20261120000100_security_privacy_marketing_scale` | failed sign-ins, email-privacy reveal tables, campaign worker columns, new enum values | |
| `20261122000100_account_contact_detail_edit_default_off` | `SET DEFAULT false` on that column | **new rows only**; no existing row is rewritten; administrators created by the CRM are stored ON explicitly |
| `20261122000200_marketing_send_cancelled_status` | adds the label `CANCELLED` to the `MarketingSendStatus` enum | one `ALTER TYPE ... ADD VALUE`; no row is read or changed. **Apply it BEFORE the new image serves** (`deploy.sh --migrate` does): the new code reads and writes the label. PostgreSQL cannot remove an enum label, so rolling the application back leaves it unused (harmless) |

`/api/health` shows `schema=pending` and System Health lists the pending names until they are applied. The customer-email reveal reset (1:15 PM Pacific) needs **no** migration: it reuses the existing reveal tables with a new period key (`p20261122`-style, 9 characters, in the existing `VarChar(10)` column), and old midnight-style rows simply never match a current period.

### 19.6 Known limits to read before relying on this release

PostgreSQL behaviour of the new SQL (reveal counter, send claims, import cursor) is **not verified**; real Gmail behaviour (quota, token refresh, ambiguous outcomes) is **not verified**; Gmail cannot send large campaigns (400/day default, a few hundred a day in reality); campaign "sent" means accepted by Gmail (no open/click/bounce tracking); subscriber addresses are masked for a Marketing Agent without the unlimited switch and have no reveal flow (decision pending). Staff notification emails for New Flight Request, lead/contact reassignment and Booking Form Signed hide the customer address from any recipient who may not see it (an Administrator, or a user with unlimited access, still sees it); a recipient whose permissions cannot be read is treated as restricted. The internal New Sale / Cancellation announcement contains no customer address at all (its recipient query has no path to the contact's address), and the airline-confirmation email goes to its own explicitly chosen recipients, so neither is covered by that rule.

### 19.6a Production prerequisites and approvals still required (nothing here has been done)

* **Owner decisions / approvals:** the deployment itself; `WEBSITE_SIGNATURE_REQUIRED=true` only after the updated website is live; the per-visitor limit value; acceptance of the 3 high tooling advisories (not in the runtime image); retention and consent policy for visitor IPs; the campaign provider and capacity decision (`COMPASS_CAMPAIGN_SENDING_CAPACITY.md`); one approved test email to a mailbox you own for the unsubscribe header.
* **City-level locations (optional, needs your approval to change the deployment):** the container has no GeoIP database today, so locations stay country-only. See `GEOIP.md` section 2b for the exact source, licence, file placement, volume and variable (`GEOIP_DB_PATH`). Nothing was downloaded or installed.
* **Environment variables, by name only** (all already documented in section 2; no new required variable was added by this release): `DATABASE_URL`, `CRON_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY`, `CARD_ENCRYPTION_KEY`, `IP_ENCRYPTION_KEY`, `IP_HASH_KEY`, `LEAD_INGEST_SECRET`, `TRUSTED_PROXY`, `WEBSITE_SIGNATURE_REQUIRED` (optional), `CAMPAIGN_SENDS_PER_MINUTE` / `CAMPAIGN_DAILY_LIMIT` (optional; defaults 20 / 400), `GEOIP_DB_PATH` (optional). Existing secrets are preserved: nothing in this release rotates, renames or removes one.
* **External, not verifiable from code:** real Gmail quota and delivery behaviour, Google Workspace sign-in / two-step policy, the production VPS state and Cloudflare, DNS (SPF / DKIM / DMARC), a restore rehearsal of a real backup, an upgrade rehearsal on a copy of real data.
* **Run ONE application instance** (the in-process poller); take the backup first (`deploy.sh --migrate` also does).

### 19.7 Deploying a release-branch commit (without merging into `main`)

Rules live in `deploy/release-policy.sh` and are exercised by `src/__tests__/release-branch-deploy-policy.test.ts`. Pushing a branch never triggers any of this; a person on the VPS has to type both the branch and the full commit id.

```bash
cd /opt/compass-tools
bash deploy/backup-db.sh                  # explicit backup first (--migrate also takes one when tables exist)
bash deploy/deploy.sh --release-branch release/compass-tools-2026-11-22 --ref <FULL-40-CHARACTER-COMMIT-ID> --migrate
bash deploy/verify.sh
```

What the script checks before it builds or changes anything (each one stops with a message and "Nothing was changed"):

1. `--release-branch` must be exactly `release/<name>` (letters, digits, `.`, `_`, `-`). `main`, `review/*`, `feature/*`, `..`, option-looking or shell-looking names are refused.
2. `--ref` is mandatory and must be the **full lower-case 40-character commit id**. A branch name, a tag, an abbreviation, `HEAD` or "latest" is refused: a moving name can never change what gets deployed after someone approved it. There is no default and `main` is never substituted.
3. The checkout is clean (as always); then **exactly that branch is fetched** and the commit must be its tip or an ancestor of it.
4. GitHub's public check-runs API must report each required job of the workflow (static checks, unit + real-database integration tests, Docker image + Compose smoke test) as completed + success **for that exact commit**, as reported by the GitHub Actions app (a same-named check from another app does not count; the newest run of each; the report-only dependency audit is not required). If GitHub cannot be asked (private repository, no network, rate limit, unreadable answer) the answer is NO. `--ci-attested` is the explicit, visible way for the approver to say they read the CI result themselves; use it only after checking the green run for that commit in GitHub.
5. Then the unchanged safeguards apply: confirmation prompt with the incoming commits and migration files, detached checkout of the commit, image tagged with the 12-character commit id, migration gate with a verified backup, health check, `verify.sh`, and `rollback.sh` for the previous image. (`deploy.sh` restores `main` automatically on the next default deploy.)

Dependency on the website: deploy the CRM first and the website second. The website must not send anything the deployed CRM does not accept yet; the v1 signed visitor context and the bearer-key + `Idempotency-Key` contract in this release stay compatible with the website that is live today. The newer request-signing (v2) and per-client flight limiter exist only as uncommitted work of another session and are **not** part of this release (see `COMPASS_SEQUENCE_WORKFLOW_RELEASE_READINESS.md`, section "Release branch").

Production was not touched while preparing this: no connection to the VPS, no deploy, no migration, no restart, no environment or DNS change, no real email.
