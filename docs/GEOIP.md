# IP geolocation for "Last sign-in location"

The Admin **Users** page shows, for every account, when it last signed in, the **full IP address** (Administrators only) and an
**approximate location** derived from that address. This document explains how the location is produced, how to install and
update the database it needs, and what it can and cannot tell you.

> A location here is an estimate of where a **network** is, not where a person is. VPNs, mobile and corporate networks, privacy
> relays, anycast and IPv6 all make it coarse or wrong. It is shown as "approximate" everywhere it appears, and it must never be
> used to accuse, discipline or block anyone on its own.

## 1. Why the column used to say "Location unavailable"

Sign-in stored the IP (read from the trusted proxy header) but took the **location only from Vercel's edge headers**
(`x-vercel-ip-city`, …), and only when the platform was detected as Vercel. On any other host — a VPS behind Cloudflare Tunnel, nginx,
a load balancer — those headers do not exist, so the location columns were always empty and the page fell back to "Location
unavailable". The IP and the location came from two different mechanisms; only the IP one worked off Vercel. Nothing was failing
at run time; the lookup simply did not exist outside Vercel.

## 2. How it works now

```
browser → [Cloudflare / reverse proxy] → CRM → sign-in
        → getClientIp()  (trusted-proxy rules; IPv4/IPv6 validated; IPv4-mapped IPv6 → IPv4; private/internal addresses refused)
        → location:  1. platform geo headers (Vercel), if present                      (unchanged behaviour)
                     2. LOCAL database lookup by that trusted IP                        (new; since 2026-11-22 it also
                        COMPLETES a platform location that names only a country - section 2a)
                     3. Cloudflare's CF-IPCountry — country only — when Cloudflare is the trusted proxy   (new, fallback)
        → stored on the Account row with its source and time → shown to Administrators on /users
```

* The lookup is **local**: a file read once, then in-memory lookups (microseconds). No third-party request is made when someone signs
  in and the address never leaves the server.
* **Never blocks or breaks sign-in.** A missing, corrupt, wrong-type or outdated database yields "no location" and the sign-in
  proceeds; the IP is still stored.
* **Nothing is invented.** A country-only record shows only the country (`Germany`); a city record shows `City, Region, Country`;
  nothing known shows `Location unavailable`. DB-IP's bracketed district suffix (`San Jose (Tasman and Zanker)`) is dropped — it
  reads as an address and the data cannot support that precision.
* **No lookup without a trustworthy IP.** The lookup is keyed only by the address the trusted-proxy rules accepted. A request on an
  untrusted path (no `TRUSTED_PROXY`) gets no IP and therefore no location, whatever headers it carries.

### 2a. Why results were often "country only", and what changed (2026-11-22)

Two causes were found by reading the code and the deployment files (nothing was run against production):

1. **Operational - the database is not provisioned by the VPS deployment.** `Dockerfile`, `compose.yaml` and the `deploy/` scripts do not mention GeoIP at all; the file is installed only by an operator (`npm run geoip:download -- --accept-cc-by-4.0` or `geoip:install -- <file>`, `GEOIP_DB_PATH`, a persistent volume - see `.env.example`). On a server where that was never done, every lookup answers `database-missing` and the only location left is Cloudflare's country. **This is the most likely reason for country-only results in production, and it is not fixable in code.** It needs the owner's approval to download or install the DB-IP file (CC BY 4.0, attribution required), to mount it on a persistent volume and to set `GEOIP_DB_PATH`. `npm run geoip:verify` then states whether the file is usable. Until then country-only is the honest result.
2. **Code - a partial location blocked the lookup.** Four places asked the local database only when NOTHING was known (`withLocalLocation`, the verified-visitor branch of `inquiry-submission-info.ts`, `resolveSignInContext`, `geoColumnsFor` in `ip-capture.ts`). A signed website context or an edge header that carried just a country therefore kept the record country-only although the same database knows the city and region.

**Correction.** One helper, `completeLocationFromDatabase` (`src/server/geo/complete-location.ts`), is now used at all four places. When the platform/website location has **no city**, it asks the local database about the already-trusted IP and fills **only the missing fields**, and only when the answer **agrees**:

| Situation | Result |
| --- | --- |
| nothing known, database has city + country | the whole answer, source = the database (unchanged behaviour) |
| country only known (e.g. `DE`), database has Frankfurt / Hesse / `DE` | city, region and time zone are added; the source names both origins, e.g. `Cloudflare edge country (CF-IPCountry) + DBIP-City-Lite (2026-11-01)` |
| known country differs from the database's (`DE` vs `FR`) | **nothing is merged**; the known value stands with its own source |
| known region differs from the database's region name and code | nothing is merged (no city of another region is attached) |
| database answer is itself country-only, or has no region | the record stays that coarse; no city or region is invented |
| a city is already known | the record is left exactly as supplied; the database is not asked |
| invalid IP, private / loopback / reserved IP, database missing, corrupt, no record, timeout or a malformed answer | the input is returned unchanged; nothing throws; sign-in and form submission are unaffected |

Unchanged on purpose: only an address that passed the trusted-proxy rules is ever looked up (a forged forwarded-for header still gets no location); no coordinates are stored; the address never leaves the server; **no third-party geolocation service is called**; the latest-only retention of the last sign-in IP/location (overwritten at the next sign-in, removed with the account) and the Administrator-only full-IP visibility are not touched. No provider was changed and nothing was signed up for.

**Display.** The lead and CRM-inquiry "Submission & IP Information" panels show City, Region, Country, Country Code and Time Zone **only where they exist**, now with a "Location source" line next to a location. A country-only record is shown as a country (never padded with a city). The text stays "approximate, derived from the IP address": it locates the network, not the person, and VPNs, mobile carriers, corporate gateways and IPv6 make it wrong or coarse.

**Tests (synthetic documentation-range IPs only).** `src/server/geo/__tests__/complete-location.test.ts` (provider answers: city + country, country-only, region missing, invalid IP, private IP, database missing / corrupt, no record, timeout, synchronous failure, malformed answers, country and region conflicts, label length) plus the sign-in, inquiry, lead and display tests listed in the final report. The real mmdb reader is covered by the existing `ip-geolocation.test.ts`.

### 2b. City-level locations in production: prepared, NOT installed (prepared 2026-11-22)

**State today: nothing is installed on the production server and nothing has been downloaded there.** Until someone runs the one-time steps below, production shows
**country-level** locations at best (or "Location unavailable" when even the country is unknown). That is honest and safe: a city is never shown unless a database returned it.

What the repository now provides (all inert until the operator acts):

* `compose.yaml` forwards `GEOIP_DB_PATH` to the app (default `/var/lib/compass-tools/geoip/city.mmdb`) and mounts the **named volume `geoip_data` read-only** into the app at
  `/var/lib/compass-tools/geoip`. The app can read the file but can never write or replace it.
* A `tools`-profile one-shot service **`geoip-update`** is the only writer of that volume. It is never started by `docker compose up`; it has **no database access**,
  no secrets and no uploads; its only network is a separate `egress` network used to reach `download.db-ip.com`; no long-running service is on that network. It runs
  `scripts/geoip-database.ts download --accept-cc-by-4.0`, which validates the file (City database, sane build date, sample lookups) and installs it with an atomic
  rename, keeping the previous copy as `city.mmdb.previous`. A failed or truncated download can never replace a working file.
* The Dockerfile creates the mount point owned by the unprivileged `node` user in both the runner and tools stages, so a freshly created volume is writable by the job and
  readable by the app. The CI smoke test (`deploy/ci-smoke.sh`) checks exactly this: the job writes, the app reads, the app cannot write.
* Status is visible: System Health row **IP geolocation database** (Ready / Out of date / Unusable / Not installed) and `/api/health` `readiness.geoIpDatabase`
  (`ready`, `stale`, `missing`, `unusable`; categories only, never a path or a record). Not installed is reported as optional (healthy with a note), out of date (> 90 days) and
  unusable are warnings. A stale file is still used.

**To enable city-level results (an owner-approved deployment step; the person who runs it accepts the licence):**

1. Deploy the version that contains this change (`bash deploy/deploy.sh`). This recreates the app with the empty read-only volume; behaviour is unchanged (country-level).
2. Load the database, once, from the deployment directory on the VPS:
   ```bash
   docker compose --profile tools run --rm geoip-update
   ```
   Running this command is the operator's confirmation of the DB-IP licence (CC BY 4.0, attribution "IP geolocation by DB-IP", already shown on the Admin Users page). It needs
   outbound HTTPS from the VPS to `download.db-ip.com` and about 125 MB of disk and RAM. MaxMind GeoLite2 City (account, licence key, EULA) is the alternative: download it yourself
   and put it in the volume with `docker compose --profile tools run --rm -v "$PWD/city.mmdb:/tmp/city.mmdb:ro" --entrypoint npx geoip-update tsx scripts/geoip-database.ts install /tmp/city.mmdb`.
3. Check **System Health → IP geolocation database**: it should say Ready with the product name and build date. **No app restart is needed**: the app re-checks the file at most
   once a minute and swaps a valid replacement in; a bad replacement keeps the previous database.
4. **Monthly refresh:** repeat step 2 (DB-IP publishes on the 1st). A file older than 90 days still works but raises a warning in System Health. The command refuses to install a file that is older than, or less than half the size of, the one in use, and two runs cannot overlap (section 3b). `docker compose --profile tools run --rm --entrypoint npx geoip-update tsx scripts/geoip-database.ts status` prints the installed database and the outcome of the last attempt.
5. **Rollback:** `docker compose --profile tools run --rm --entrypoint rm geoip-update -f /var/lib/compass-tools/geoip/city.mmdb` (or delete the `geoip_data` volume): locations fall back to country level. No customer data is
   in the volume.

**What accuracy to expect.** The country is almost always right. City and region are right much of the time for fixed-line networks and wrong for mobile carriers, VPNs and
cloud / anycast addresses; they are estimates of the network's registration or routing, never the person's position. The application never invents a city or region: it
shows only what the database returned for the trusted IP, labels it approximate, and distinguishes "city-level", "country-only", "private/reserved address" and "unavailable".

**Not verified here:** Docker is not available on the development machine, so the compose and Dockerfile changes were checked by YAML parsing, the compose guard tests and the new
CI smoke step, not by running the stack locally. The download from DB-IP was **not** performed against the real host in this review (only the CLI's validation and the
lookup code are covered by tests, with generated databases).


## 3. Choosing and installing the database

Any MaxMind-format **City** database (`.mmdb`) works. Both candidates below were evaluated; the application is licence-neutral.

| | **DB-IP "IP to City Lite"** (recommended default) | MaxMind **GeoLite2 City** | Paid (DB-IP / MaxMind GeoIP2) |
|---|---|---|---|
| Account / key | none | free account + licence key | subscription |
| Licence (read 2026-11-08 from the vendors' pages) | CC BY 4.0 — credit DB-IP.com; use in your application allowed | CC BY-SA 4.0 + GeoLite EULA — credit MaxMind; no redistribution; must use updates promptly and delete old versions within 30 days; some commercial uses need the Commercial GeoLite licence | commercial, no attribution |
| Updates | monthly (published on the 1st) | frequent — see MaxMind's page | per vendor |
| Size | ~121 MB (IPv4 + IPv6 in one tree) | see MaxMind's page | per vendor |
| Fields present (see section 3a) | city, subdivision **name**, country (code and name), latitude/longitude. **No time zone, no subdivision code, no accuracy radius.** | adds subdivision code, time zone and accuracy radius | more |
| Accuracy (vendor's own index) | 77, vs 96 for DB-IP's paid product (7.8 M records vs 40.3 M) | not independently measured here | highest |

Neither free database is "accurate to a person": expect country to be right almost always, region/city right much of the time
for fixed-line residential and office networks, and wrong for mobile carriers, VPNs and cloud/anycast addresses.

**Install (DB-IP Lite — no account needed):**

```bash
npm run geoip:download -- --accept-cc-by-4.0                 # downloads, validates, installs to $GEOIP_DB_PATH
npm run geoip:verify -- --ip 8.8.8.8                        # prints type, build date, age; optional sample lookup
```

**Install (GeoLite2 or a paid file you obtained yourself):**

```bash
npm run geoip:install -- /path/to/GeoLite2-City.mmdb        # validates, then atomically installs
```

Where the file lives: `GEOIP_DB_PATH` (absolute path) or, by default, `data/geoip/city.mmdb` under the app's working directory.
In Docker, mount a **persistent volume** at that path (the file must survive container rebuilds; it is ~120 MB and is never part
of the image or of Git — `*.mmdb` and `/data/geoip/` are git-ignored). Keep any licence key in environment variables, never in the repo.

**Updating without a rebuild or restart.** `install`/`download` validate the new file (opens as a City database, sane build date,
size) and replace the old one with a single rename, keeping the previous file as `city.mmdb.previous` (rollback = rename it back).
The running app re-checks the file's timestamp at most once a minute and swaps in the new database; if the new file is bad it keeps
serving the old one. Databases older than 90 days still work but are flagged and logged once ("database is N days old").

**Do not schedule automatic updates until you have decided how.** A monthly job running `npm run geoip:download -- --accept-cc-by-4.0`
is safe by design (validate-then-rename, keeps `.previous`), but it makes an outbound request from the server and changes a file in
production, so enabling it is an operations decision. A suggested crontab (not activated anywhere): `15 4 2 * *`.

Attribution (a licence condition) is shown automatically wherever a stored location that came from DB-IP or MaxMind is displayed: under the Users table, on the Failed sign-ins page, and in the lead and CRM-inquiry "Submission & IP Information" panels (a location from the edge's own country header, or no location, carries no credit).

### 3a. What each edition provides, and what Compass-Tools does with it

Checked against DB-IP's published MMDB schema (https://db-ip.com/db/format/ip-to-city-lite/mmdb.html) and against the fields the code reads:

| Field | DB-IP "IP to City Lite" (the default) | MaxMind GeoLite2 City | What Compass-Tools does |
|---|---|---|---|
| Country name and ISO code | yes | yes | stored and shown; a country-only record stays country-only |
| First-level subdivision (state, province) | **name** only | name and ISO code | the **name** is stored as the region; the code is stored nowhere and shown nowhere |
| City | yes (a district in brackets is stripped) | yes | stored and shown only when the record has one; never inferred from a region, country or ISP |
| Time zone | **no** | yes (`location.time_zone`) | shown only if the database supplies one; **with DB-IP Lite it is empty and is not guessed from the country** (a country can span several zones) |
| Latitude / longitude | yes | yes | read, never stored |
| Accuracy radius | no | yes | read, never stored or shown |

So with the default database the application can honestly show **City, Region, Country** and the country code, but **not a time zone**. If a reliably sourced time zone is required, the options are MaxMind GeoLite2 City (free account, licence key, GeoLite EULA, CC BY-SA 4.0 credit) or a paid edition; both are installed with `install <file>` and need no code change. That is an owner decision; nothing was downloaded or switched in this review.

**Licence.** DB-IP Lite is CC BY 4.0: commercial use inside an application is allowed provided DB-IP.com is credited with a link on pages that display or use its results (https://db-ip.com/db/download/ip-to-city-lite). The credit is shown where listed above. DB-IP's own paid product needs no credit. MaxMind GeoLite2's terms differ (EULA; keep to its update and deletion rules) - read them before choosing it.

**Accuracy.** Country is almost always right; region and city are estimates of where the network is registered or routed. DB-IP rates its free city data well below its paid product (the figures are in section 3). Nothing in the application claims more than "approximate", and a location is never used to accuse, discipline or block anyone.

### 3b. Update safeguards, status and recovery

`npm run geoip:download` / `geoip:install` (and the `geoip-update` job) never put a worse file in place of a working one:

1. the download goes to a temporary directory and is unpacked there; a failed or partial download leaves the database untouched;
2. the file must open as a City database with a sane build date (not in the future, not a country-only or ASN file, not truncated), and the **copy** that will be swapped in is validated again;
3. a file **built earlier** than the one in use, or **less than half its size**, is refused (`--allow-older` / `--allow-smaller` for a deliberate rollback or edition change); an installed file that is itself unusable never blocks a good replacement;
4. an exclusive lock file (`city.mmdb.lock`) is held for the whole install, so two updates cannot collide; a lock left by a crashed run expires after 30 minutes;
5. the swap is one rename, and the file it replaced is kept as `city.mmdb.previous` (roll back by renaming it);
6. every attempt, successful or not, is recorded beside the database in `city.mmdb.update.json` (time, outcome, a short reason with no file paths). The command is safe to repeat.

The running application notices a replaced file within a minute and swaps it in without a restart; a replacement that fails to load keeps the previous database serving. **System Health -> IP geolocation database** (and `/api/health` `readiness.geoIpDatabase`, a category only) shows: Ready, Out of date (over 90 days), Not installed, or Unusable, plus when the file was built, when it was installed here, the last update attempt and the last successful update. A failed latest attempt raises a warning even while the old database is still serving, and says so.

If the application starts with no database, or a broken one, nothing else changes: the lookup returns "no location" (never throws), sign-in and form submissions proceed, the IP is still recorded, and locations are country-level at best.

## 4. IP capture and the trust boundary (`TRUSTED_PROXY`)

The location is only as trustworthy as the IP, and the IP is only as trustworthy as the proxy configuration:

| `TRUSTED_PROXY` | Header believed | Meaning / what must be true |
|---|---|---|
| unset / `none` | none | No IP, no location. Secure default (and correct for `next dev`). |
| `vercel` (auto on Vercel) | `x-vercel-forwarded-for`, `x-real-ip`, `x-forwarded-for` | Vercel's edge overwrites these. |
| `cloudflare` | `cf-connecting-ip` only | Cloudflare sets this on every request it proxies, overwriting any client value. **True only if the origin cannot be reached except through Cloudflare** — with Cloudflare Tunnel that means no published/forwarded port and no other route (firewall, compose network) to the app. The application cannot verify this itself; if the origin were directly reachable, anyone could send `CF-Connecting-IP: <any address>` and choose the IP *and* the derived location. |
| `nginx` / `generic` | `Forwarded`, first `x-forwarded-for` hop, `x-real-ip` | Your proxy must overwrite (not append to) these. |

Rules enforced in code: only the configured mode's headers are read (a forged `X-Forwarded-For` is ignored under `cloudflare`);
the value must parse as IPv4/IPv6; IPv4-mapped IPv6 (`::ffff:203.0.113.9`) is stored as the plain IPv4; **IPv6 is stored in full
as received** (the column is unbounded text); private, loopback, link-local, unique-local and carrier-grade-NAT (`100.64.0.0/10`)
addresses are refused — they are an internal hop (a Docker bridge, Tailscale, a misconfigured proxy), never a visitor — and then no
IP and no location are stored for that sign-in. Since 2026-11-23 the refusal also covers IPv6 forms that carry or stand in for such an address: 6to4 (`2002::/16`) and NAT64 (`64:ff9b::/96`) wrapping a private IPv4, the local-use NAT64 prefix, the discard prefix `100::/64` and the deprecated IPv4-compatible `::/96`. (The documentation ranges 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 and 2001:db8::/32 are deliberately not refused: they are what every test uses as a stand-in for a public visitor, and no real traffic uses them.)

Recommended configuration for the VPS + Cloudflare Tunnel deployment: `TRUSTED_PROXY=cloudflare`, with the app container reachable
**only** from the `cloudflared` container (internal Docker network, no `ports:` mapping to the host). **Production configuration is
not changed by this work** — see the release notes for the exact check to run.

## 5. Data stored, who can see it, retention

Per account, only the **latest** successful sign-in is kept (it is overwritten by the next one): IP (`lastSignInIp`), city, region,
country, country code, time zone, plus two provenance columns added here — `lastSignInLocationSource` (database product + build
date, e.g. `DBIP-City-Lite (2026-11-01)`) and `lastSignInLocationAt` (when it was resolved). No history, no per-address cache table,
no coordinates (the lookup can return latitude/longitude, but they are deliberately **not stored**: a city centroid adds nothing the
page shows and would widen the personal-data footprint — storing them is a one-line follow-up if you decide you want them).

All of these columns are omitted from every ordinary Prisma read (global `omit`) and returned only by the Administrator-only Users
query; the IP is shown in full only on `/users` (Administrators) and nowhere else. Retention is "until the user's next sign-in
overwrites it, or the account is deleted" — **a business/legal decision** whether that is acceptable for staff location monitoring
in your jurisdiction (notice to employees, purpose limitation, whether the full IP should be shown versus only the location).

## 5a. Other capture points (public inquiries, flight-request leads, bookings)

The same trust rules (section 4) and the same local database are used everywhere an IP is recorded; nothing is taken from a request body, and
no new external geolocation provider is involved.

| Record | Where | Source of the IP | Source of the location | Who can see the full IP |
| --- | --- | --- | --- | --- |
| Last sign-in | `Account.lastSignIn*` | trusted path (`getClientIp`) | platform headers → local database → Cloudflare country | Administrators on `/users` |
| Booking signature / cancellation confirmation | encrypted `IpCapture` vault | trusted path | platform headers → **local database** (`recordIpCapture`) | Reveal: Admin, or Manager/Ticketing with the booking grant; recent sign-in; audited |
| Flight-request lead (`/api/public/lead-capture`, `/api/v1/website/flight-inquiries`) | `LeadSubmissionInfo` | trusted path, or the website's **signed** visitor context (server-to-server) | platform headers / signed context → **local database** (`withLocalLocation`) | masked; Reveal as for bookings; audited |
| **CRM Inquiries** (`/api/public/crm-inquiry`) | `InquirySubmissionInfo` (new) | trusted path — the request IS the visitor | platform headers → local database → Cloudflare country (`resolveSignInContext`) | Admin only; masked; Reveal needs a sign-in within 15 minutes; audited (`INQUIRY_IP_REVEALED`) |
| **Business Flights "Get In Touch"** (`/api/public/contact-inquiry`) | `InquirySubmissionInfo` (new) | **only** a verified signed visitor context (`x-ct-visitor-context` + `-signature`, HMAC with `LEAD_INGEST_SECRET`) | that context's location, else the local database | Admin only; same Reveal |

* The two inquiry systems stay separate: their own routes, `source` values, inboxes and rate-limit counters. Both write their
  `InquirySubmissionInfo` row in the **same insert** as the inquiry (nested create), so it can never be lost or detached.
* `/api/public/contact-inquiry` is called by the Business Flights website's **server**, so the connection and every forwarded header describe
  that server, not the visitor; they are never used. Until the website attaches the signed visitor context to that request, **no IP/location is
  recorded for those inquiries** (the inbox then says "No IP address or location was recorded"). That is website-side work and is deliberately not
  done here.
* No latitude/longitude is stored in any of these tables.
* Retention of the inquiry and lead rows is the retention of the inquiry/lead itself (cascade delete); there is no separate purge job. Whether
  that is acceptable for visitor IPs is a business/legal decision.
* Migration `20261113000100_inquiry_submission_info` only creates the new table; **it has not been applied to any database**.

## 6. Backfilling accounts that signed in before the database existed

The data model stores one last sign-in per account, so the backfill is at most one row per user. A bounded, idempotent script exists
but is **not run automatically**:

```bash
npx tsx scripts/backfill-sign-in-locations.ts            # dry run: counts only, writes nothing, prints no addresses
npx tsx scripts/backfill-sign-in-locations.ts --apply    # fills EMPTY location fields only (never an existing location/IP/time)
```

Running it against production needs explicit approval. Note that it resolves today's database against an older sign-in's IP; the
stored `lastSignInLocationAt` records when that happened.

## 7. Operating notes

* Memory: the whole file is read into RAM (~125 MB). First lookup after a (re)start loads it (~70 ms measured locally); later lookups
  are ~7 µs.
* Serverless/Vercel: not applicable there (the platform headers are used and no file is needed); on a host with no writable
  persistent storage use the platform headers or a paid API instead.
* Logs: at most one warning per cause (bad file, stale database); the message never contains an address.
