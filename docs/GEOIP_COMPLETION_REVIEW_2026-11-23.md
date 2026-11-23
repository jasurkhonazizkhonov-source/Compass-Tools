# GeoIP completion review (2026-11-23)

Branch `release/compass-tools-2026-11-22`, starting at `c2a98df` (three local commits on top of the remote's `9e22da9`). Local code, tests and documentation only. **No database was downloaded or installed anywhere, nothing was deployed, no production setting, secret or record was touched.** The procedure for production is in `docs/GEOIP.md` section 2b; running it needs separate approval.

## 1. What already existed (read, not assumed)

A local MaxMind-format City database (DB-IP "IP to City Lite" by default, GeoLite2 also supported) is read by `src/server/geo/ip-geolocation.ts`: it takes only an address the trusted-proxy rules already accepted, never throws, never calls an external service, reloads a replaced file without a restart and keeps the previous database if a replacement fails. `complete-location.ts` fills a platform location that has only a country from the same database, refusing to blend two sources that disagree. Sign-in, failed sign-in, booking, lead and inquiry capture all use it; the full sign-in IP is read by one Administrator-only query; only the latest sign-in is retained; no coordinates are stored. Docker/Compose (read-only `geoip_data` volume for the app, an on-demand `geoip-update` job on a separate egress network, `GEOIP_DB_PATH` forwarded, directory owned by the unprivileged user, a CI smoke check) and System Health / `/api/health` states (ready, out of date, not installed, unusable) were prepared on 2026-11-22.

## 2. Findings and what changed

| # | Finding | Change | Proof |
|---|---|---|---|
| 1 | **Update path could collide and could downgrade.** Two runs of the update command shared one staging name (`city.mmdb.incoming`), and nothing stopped an older or much smaller (wrong-edition) file replacing a newer working one. | `installDatabaseFile`: an exclusive lock file for the whole install (a crashed run's lock expires after 30 minutes), a staging name unique to the process, refusal of a file built earlier than, or less than half the size of, the installed one (`--allow-older` / `--allow-smaller` to override on purpose), an unusable installed file never blocks a good replacement. Existing guarantees kept: validate, copy, validate the copy, keep `.previous`, one rename. | `geoip-update-safeguards.test.ts` (older refused / allowed, smaller refused / allowed, corrupt current, truncated and non-database candidates leave the directory unchanged, live lock refused and left alone, stale lock cleared, lock released after a failure, two simultaneous installs never corrupt the file) |
| 2 | **No record of the last update** (the brief: "report update status", "document database age and last successful update"). | The operator command records every attempt, success or failure, in `<database>.update.json` beside the file (time, outcome, a short reason with file paths removed; a failure keeps the earlier success time). New `status` command (`npm run geoip:status`). `getGeoIpDatabaseStatus()` adds `installedAt` and the record; System Health shows Installed here, Last update attempt, Last successful update, and **warns when the latest attempt failed even though the old database still serves** (or when nothing is installed and the first installation failed). `/api/health` is unchanged (categories only). | `geoip-update-safeguards.test.ts` (record, failure keeps success time, path/control-character stripping, malformed or tampered record = no record, recording never throws, the CLI end to end: failed install keeps the database and records, good install records, status output, licence-flag usage error records nothing), `ip-geolocation.test.ts`, `health-checks-geoip-signing.test.ts` |
| 3 | **Licence credit missing where results are shown.** DB-IP Lite is CC BY 4.0 and asks for a credit on pages that display its results; only the Users page carried it, while the Failed sign-ins page and the lead and CRM-inquiry "Submission & IP Information" panels also show DB-IP locations. | The same credit line (chosen from the stored source, so a location from the edge's own header, or no location, carries none) is now on all of them. | `failed-signins-view.test.tsx`, `lead-submission-information.test.tsx`, `inquiry-submission-information.test.tsx` |
| 4 | **Inconsistent location text.** Failed sign-ins showed "City, Region, Country" while the Users page shows "City, Region, Country (CC)" with a repeated neighbour dropped. | Failed sign-ins now uses the Users page's own formatter. | `failed-signins-view.test.tsx` |
| 5 | **Reserved-address gaps.** IPv6 forms that carry or stand in for a private IPv4 address were treated as public: 6to4 (`2002:a00:1::`), NAT64 (`64:ff9b::a00:1`), the local-use NAT64 prefix, the discard prefix `100::/64` and the deprecated IPv4-compatible `::/96`. | All are refused (never geolocated, never stored as a client address), judged by the IPv4 they wrap. 6to4 / NAT64 around a **public** IPv4 stay valid. The documentation ranges are deliberately still accepted (every test uses them as stand-ins for visitors). | `request-ip-parsing.test.ts`, `ip-geolocation.test.ts`, `sign-in-context-cloudflare-location.test.ts` |
| 6 | **The update job itself was never executed in CI** (the smoke test only checked the volume). | The CI smoke step now runs `geoip-update ... status` inside the tools image (tsx, the MMDB reader, the volume), which needs no network and changes nothing. | `deploy/ci-smoke.sh` (runs in GitHub Actions only: Docker is not installed on the development machine) |
| 7 | Trust matrix for sign-in capture was thin. | Tests: no trusted proxy / `none`: no header is believed and the database is never asked; Cloudflare mode reads only `CF-Connecting-IP` (a Vercel city header or `X-Forwarded-For` cannot change address or place); the database is asked about the trusted address only; internal or malformed `CF-Connecting-IP` values record nothing; a failing or malformed database answer never breaks sign-in; unknown / Tor / malformed Cloudflare country codes name no place. | `sign-in-context-cloudflare-location.test.ts` |

## 3. Provider, edition and fields (verified from the vendor's schema page and from the code that reads the file)

* **Provider and edition:** DB-IP "IP to City Lite", MMDB, monthly (published on the 1st), about 121 MB, licence **CC BY 4.0** (credit and link required; commercial use in an application is allowed). GeoLite2 City is supported by the same code (free account and licence key, GeoLite EULA, credit to MaxMind). The default was **not** changed.
* **Supported fields (DB-IP Lite):** country name and ISO code, first-level subdivision **name**, city, latitude/longitude. **Not supported: time zone, subdivision ISO code, accuracy radius.**
* **What the application shows and stores:** city, region (the subdivision name), country, country code, the time zone **only if the database supplies one** (so empty with DB-IP Lite; it is never guessed from the country, which may span several zones), the source and when it was resolved. Coordinates are read and discarded. A reliably sourced time zone needs GeoLite2 City or a paid edition (`install <file>`, no code change): an **owner decision**.
* **Accuracy and fallback:** country is almost always right; region and city are estimates of where the network is registered or routed (VPNs, mobile and corporate networks, privacy relays and IPv6 make them coarse or wrong). A country-only record stays country-only; a record with a region and no city gets no city; no record, a private or malformed address, a missing, stale or unusable database all give "no location" or the Cloudflare country, never a guess; sign-in is never affected.

## 4. Update and recovery behaviour (summary of `docs/GEOIP.md` 3b)

Download to a temporary directory; validate; validate the copy; refuse older or much smaller files; hold the lock; one rename; keep `.previous`; record the attempt; the application picks the new file up within a minute and keeps the old one if the new one will not load. The job is safe to repeat. A missing, stale or unusable database never prevents startup.

## 5. Privacy and security checks

* Full sign-in IP: read only by `getAccountSignInDetails` (Administrator-only; `users` and `failed-signins` pages 404 for anyone else); `lastSignInIp` is omitted from every other Prisma read by the global `omit`. Lead and inquiry panels show the masked address; the full one needs the audited, step-up Reveal. Tests: `account-sign-in-details.test.ts`, the lead / inquiry reveal tests, `session-lifecycle.integration.test.ts`.
* Retention unchanged: only the latest successful sign-in is kept, until the next sign-in or the account's deletion.
* No external geolocation API is called; the address never leaves the server; no new personal data is collected; no coordinates are stored.
* `/api/health` reports a category only (`ready`, `stale`, `missing`, `unusable`); System Health reports no path and no record (tested).
* Database path: `GEOIP_DB_PATH` comes from the environment only, never from a request; the update command's `--target` is an operator argument.

## 6. Production installation and update (not performed; needs your approval)

Exactly as `docs/GEOIP.md` section 2b: deploy this version (`deploy/deploy.sh`), run `docker compose --profile tools run --rm geoip-update` once (running it is the licence acceptance), check System Health, repeat monthly, roll back by renaming `city.mmdb.previous`. Outbound HTTPS to `download.db-ip.com` and about 125 MB of disk and memory are needed. Nothing here changes a production environment variable.

## 7. Still open (owner decisions and external work)

Strict website signing (`docs/WEBSITE_SIGNING_STRICT_MODE.md`); whether a time zone is required (then GeoLite2 or a paid edition); bounce and complaint handling, sending provider and capacity, retention and consent policy; Workspace two-step verification, VPS firewall and Cloudflare-only origin access, backup restore rehearsal, real Gmail delivery; a real secret scanner (none installed; a pattern scan was run); physical-device and screen-reader checks. None can be verified from the repository; none was changed.

## 8. Verification

Development machine (Windows, Node 24), against the tree that is committed:

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| ESLint (all changed code and test files) | clean |
| `prisma validate` | valid |
| `npm run build` | succeeded; `server-action-surface.test.ts` 10 / 10 against its manifest |
| Full unit suite (`--maxWorkers=3`) | **5,478 passed, 592 skipped, 0 failed** (360 files passed, 31 skipped). The 592 skips are the database-gated suites, run next. New and extended this pass: `geoip-update-safeguards` (22 incl. the CLI end to end), `ip-geolocation` (+8), `request-ip-parsing`, `sign-in-context-cloudflare-location` (+30), `health-checks-geoip-signing` (+4), and the credit / format tests in the failed sign-ins, lead and inquiry component suites |
| Real-database integration suites (local, serial, throw-away PostgreSQL 18.7 with TLS) | **32 files, 624 passed, 1 skipped, 0 failed**. CI uses PostgreSQL 17 in Docker. |
| `npm audit` | unchanged (no dependency was added or changed; last run 0) |
| Docker image build, Compose smoke test (incl. the new `geoip-update status` step) | **not run locally (Docker is not installed on this machine)**; GitHub Actions only |
| Real database download from DB-IP | **not performed** (not authorised); the update path is covered with generated databases |
| GitHub Actions on the pushed commit | see the final report |

