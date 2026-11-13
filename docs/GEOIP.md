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
                     2. LOCAL database lookup by that trusted IP                        (new)
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

## 3. Choosing and installing the database

Any MaxMind-format **City** database (`.mmdb`) works. Both candidates below were evaluated; the application is licence-neutral.

| | **DB-IP "IP to City Lite"** (recommended default) | MaxMind **GeoLite2 City** | Paid (DB-IP / MaxMind GeoIP2) |
|---|---|---|---|
| Account / key | none | free account + licence key | subscription |
| Licence (read 2026-11-08 from the vendors' pages) | CC BY 4.0 — credit DB-IP.com; use in your application allowed | CC BY-SA 4.0 + GeoLite EULA — credit MaxMind; no redistribution; must use updates promptly and delete old versions within 30 days; some commercial uses need the Commercial GeoLite licence | commercial, no attribution |
| Updates | monthly (published on the 1st) | frequent — see MaxMind's page | per vendor |
| Size | ~121 MB (IPv4 + IPv6 in one tree) | see MaxMind's page | per vendor |
| Fields typically present | city, subdivision, country, latitude/longitude (no time zone or accuracy radius — measured) | adds time zone and accuracy radius | more |
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

Attribution (a licence condition) is shown automatically under the Users table whenever a stored location came from DB-IP or MaxMind.

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
IP and no location are stored for that sign-in.

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
