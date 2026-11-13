# CRM Full IP and Geolocation Verification

Date: 2026-11-13. Scope: `compass-tools-updated` only (the original `compass-tools` and both website projects were not modified). Evidence is code reading plus automated tests with **mocked headers and fake documentation addresses** (203.0.113.x, 198.51.100.x, 2001:db8::/32). No real visitor, no real submission, no database and no production service was involved.

## 1. Result in one paragraph

IPv4 and IPv6 client addresses are captured in full, in one canonical text form, and nothing is truncated. One defect was found and fixed: IPv6 validation used a hand-written pattern that rejected some valid addresses (embedded-IPv4 tails written without `::`) and the same address could be stored in several spellings. Validation now uses Node's own parser (`net.isIP`), IPv6 is stored in canonical RFC 5952 form, IPv4-mapped IPv6 collapses to the IPv4 it stands for, and a few more reserved ranges are refused. Cloudflare's city/region headers are now read (and labelled as approximate) when the trusted proxy is Cloudflare. Coordinates are still never read or stored.

## 2. Where the client address comes from (trusted-proxy model)

`TRUSTED_PROXY` selects exactly one trust model; a header outside the selected model is never believed. Code: `src/lib/request-ip.ts` (`getClientIp`, `trustedProxyConfig`).

| `TRUSTED_PROXY` | Headers read | Everything else |
| --- | --- | --- |
| `cloudflare` (what `compose.yaml` sets) | `CF-Connecting-IP` only | `X-Forwarded-For`, `X-Real-IP`, `Forwarded`, `True-Client-IP` ignored, even if CF-Connecting-IP is missing |
| `vercel` | `x-vercel-forwarded-for`, `x-real-ip`, `x-forwarded-for` | `CF-Connecting-IP`, `Forwarded` ignored |
| `nginx` / `generic` | `Forwarded`, then the **first** `X-Forwarded-For` hop, then `X-Real-IP` | `CF-Connecting-IP` ignored |
| `none` / unset | nothing | the address is "unavailable" |

Precedence is therefore fixed per mode, not negotiated per request. `True-Client-IP` is not honoured in any mode (Cloudflare's own documentation treats it as an alias of CF-Connecting-IP; honouring it would only add a second spoofable name). A resolved value in a private/reserved range is treated as unavailable (a misconfigured chain leaking an internal hop), so a Docker bridge address (172.16.0.0/12), loopback, link-local, carrier-grade NAT, `fc00::/7`, `fe80::/10`, and now also site-local, multicast, 192.0.0.0/24, 198.18.0.0/15 and 224.0.0.0+ are never stored as a visitor.

How production supplies the client IP: the VPS stack runs behind a Cloudflare Tunnel; Cloudflare sets `CF-Connecting-IP` to the real visitor address and the app (with `TRUSTED_PROXY=cloudflare`) reads only that header. The origin must not be reachable except through the tunnel (see `docs/DEPLOYMENT.md`), otherwise anyone could send their own `CF-Connecting-IP`. The tests prove the header is ignored in every other mode.

## 3. Defects found and fixed

| # | Problem | Fix | Files |
| --- | --- | --- | --- |
| G1a | Hand-written IPv6 pattern was "pragmatic, not exhaustive": rejected valid forms such as `0:0:0:0:0:ffff:1.2.3.4` and `2001:db8:0:0:0:0:192.0.2.1` | `isValidIpAddress` = non-empty, <= 45 chars, no `%` zone, `net.isIP(value) !== 0` | `src/lib/request-ip.ts` |
| G1b | The same IPv6 address could be stored as several different strings (case, leading zeros, `::` placement, mapped spellings), which also breaks the vault's exact-match hash and velocity checks | `normalizeIp`: canonical IPv6 via the WHATWG URL serializer; IPv4-mapped (dotted or hex) becomes IPv4; IPv4-compatible `::a.b.c.d` stays IPv6 canonical (it is not the same address) | `src/lib/request-ip.ts` |
| G1c | Reserved-range list incomplete | Added 192.0.0.0/24, 198.18.0.0/15, >= 224.0.0.0, `fec0::/10`, `ff00::/8`; mapped addresses are judged as the IPv4 they stand for. Documentation ranges stay public on purpose (tests use them) | `src/lib/request-ip.ts` |
| G2 | Behind Cloudflare only the country was ever captured | `readCloudflareLocation` reads `CF-IPCity`, `CF-Region`, `CF-Region-Code`, `CF-Timezone`, `CF-IPCountry`; trust-gated by `TRUSTED_PROXY=cloudflare`; labelled `Cloudflare edge geolocation (approximate)` | `src/lib/request-geo.ts`, `src/server/auth/sign-in-context.ts`, `src/server/lead-submission-info.ts` |

Policy change to note: five older test expectations asserted "IPv6 stored exactly as received". They were deliberately changed to the canonical form (`src/lib/__tests__/request-ip.test.ts`, `src/server/auth/__tests__/sign-in-context-geo.test.ts`).

## 4. Storage

All IP columns are `TEXT` (checked in `prisma/schema.prisma`), so the longest value (39-character IPv6, plus the vault's separate ciphertext/blind-index columns) is never truncated; a test asserts the longest canonical output is 39 characters. Malformed input is rejected before storage (the address is recorded as unavailable, the submission itself still succeeds).

## 5. Geolocation: what is and is not claimed

Order of sources for a sign-in: (1) platform/edge headers (Vercel; Cloudflare city/region), (2) the **local** DB-IP MMDB file (`data/geoip/city.mmdb`, optional, git- and docker-ignored, no network lookup, no third-party provider), (3) Cloudflare's country-only `CF-IPCountry`, (4) nothing. Every stored location carries a source label and a resolved-at time. A country-only Cloudflare header is deliberately not treated as a "location" so a more specific local-database answer still wins.

- It is an **approximate, network-level** location (where an IP address probably is), never an address and never the person's position. UI wording and source labels say "approximate"; no screen shows it as exact.
- **Latitude/longitude are not read or stored.** The request asked for them only "if available and useful". The standing project policy (no coordinates anywhere) was kept, and tests assert no `lat`/`lon` key appears in any returned or stored shape. Flagged as an owner decision, not changed.
- Known cosmetic limitation: a location that arrives through the website's *signed* visitor context is labelled "Vercel edge geolocation" even when the website is not on Vercel.

## 6. Display and permissions (unchanged, not broadened)

- Users page: latest sign-in IP and location per account, replaced at the next sign-in, kept until overwritten or the account is deleted; visible to **Administrators only**.
- Lead IP: masked in the CRM; reveal is audited and requires a recent login; grant model is Admin or an explicitly granted Manager/Ticketing user (this differs from "Admin-only" and is recorded as a policy decision).
- Inquiry (contact form) IP: masked; reveal is Admin-only.
- Logs: no code path was added that logs a full IP; the safe-error-log tests still pass.

## 7. Test evidence (this task)

| File | Tests | What it proves |
| --- | --- | --- |
| `src/lib/__tests__/request-ip-parsing.test.ts` | 116 | differential check against `net.isIP` over ~24,000 generated spellings; canonical form and idempotence; mapped/compatible forms; reserved ranges; full trust/precedence matrix for every `TRUSTED_PROXY` mode incl. forged headers, missing header, malformed value, internal/Docker address, multi-hop XFF |
| `src/lib/__tests__/request-geo-cloudflare.test.ts` | 15 | what is read, what is never read (coordinates, postal code), partial/missing/Tor/unknown, malformed or oversized values dropped, trust gate per mode, stored columns and labels |
| `src/server/auth/__tests__/sign-in-context-cloudflare-location.test.ts` | 8 | location precedence behind Cloudflare, forged XFF never changes stored IP or lookup, IPv6 canonical form passed to the lookup, no coordinates |
| `src/app/api/v1/website/flight-inquiries/__tests__/route.test.ts` | 26 | signed visitor context carries IPv4 and IPv6 end to end into the stored submission info; forged/stale/wrongly signed context ignored |
| existing: `request-ip.test.ts`, `sign-in-context*.test.ts`, `ip-capture.test.ts`, `lead-submission-info*.test.ts`, `inquiry-submission-info*.test.ts` | unchanged count | still pass |

Not verified (needs PostgreSQL): the encrypted `IpCapture` vault rows and the Prisma writes of the new provenance columns (`ip-geo-and-unsubscribe.integration.test.ts`, `lead-ip-authorization.integration.test.ts`, `inquiry-separation.integration.test.ts` are skipped without a disposable database). Also not verified: a real Cloudflare request (the headers are mocked); a real MMDB file lookup (the file is not in the repository; the lookup module has its own mocked tests).
