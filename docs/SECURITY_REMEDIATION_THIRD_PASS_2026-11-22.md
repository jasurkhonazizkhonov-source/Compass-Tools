# Third pass, 2026-11-22: remaining findings, vulnerabilities and release limitations

Branch `release/compass-tools-2026-11-22`, starting from `75df7b7`. **Source review, automated tests and CI only. No penetration test, no production access, nothing
deployed, no production data, setting or secret touched.** This file is a finding-by-finding record; it does not claim "zero vulnerabilities". The classifications are:

* **Fixed and verified**: changed in this pass and proven by a named test (or a command whose output is quoted).
* **Not applicable (evidence)**: the code path or exposure does not exist; the evidence is named.
* **External infrastructure limitation**: depends on something outside this repository.
* **Owner decision required**: a business or policy choice that code cannot make.
* **Unresolved vulnerability**: none was found in this pass (see the end for what that does and does not mean).
* **Unverified behavior**: could not be exercised here; what would verify it is named.

## 1. Findings

| # | Finding | Classification | Evidence / what changed |
|---|---|---|---|
| 1 | Nine npm advisories (3 high, 6 moderate): `effect` ≤ 3.22.0 (Prisma CLI), `glob` / `minimatch` (`@opennextjs/cloudflare`, `shadcn`), `ts-morph` | **Fixed and verified** | Three scoped `overrides` in `package.json` (`effect` 3.22.5, `@opennextjs/cloudflare` → `glob` 14.0.6, `shadcn` → `ts-morph` 28.0.0). `npm audit` reports **0**. No `--force`, no prerelease, no change of Prisma or Next. `src/__tests__/dependency-advisory-guards.test.ts` fails if a vulnerable copy returns. All nine were in tooling that is not in the runtime image. Detail and what was exercised: `docs/DEPENDENCY_AUDIT_2026-11-22.md` section 0. The overrides can be dropped when the parents ship fixed ranges. |
| 2 | `POST /api/public/lead-capture` could create a lead **unsigned even with strict signing on** (the other three website routes were guarded) | **Fixed and verified** | The route now goes through `guardWebsiteRequest`; signed visitor facts are used, unsigned/invalid/replayed requests are refused with 401 before anything is stored in strict mode. `src/app/api/public/lead-capture/__tests__/signature.test.ts` (signed once, unsigned, replay, modified body, other route's signature, other company, wrong secret / expired / far-future). |
| 3 | The documented switch `WEBSITE_SIGNATURE_REQUIRED=true` **could not take effect on the VPS**: `compose.yaml` forwards only variables it names, and it did not name this one. The same was true for `LEAD_INGEST_SECRET_PREVIOUS`, `CAMPAIGN_SENDS_PER_MINUTE`, `CAMPAIGN_DAILY_LIMIT`, `DISABLE_IN_PROCESS_POLLER`, `GEOIP_DB_PATH` | **Fixed and verified** (CI smoke step pending its first run) | `compose.yaml` forwards all six (empty = the code's default). `src/__tests__/compose-env-propagation.test.ts` fails when any documented, code-read setting is not forwarded (with an exemption list that needs a reason per entry and cannot rot). `deploy/ci-smoke.sh` now also proves, in a running stack, that `WEBSITE_SIGNATURE_REQUIRED` and `CAMPAIGN_DAILY_LIMIT` set in `.env` reach the container. |
| 4 | Strict website signing is not switched on in production | **Owner decision required** | Code is strict-mode ready and interoperates with the updated website's signer. Turning it on before the website that is live signs would refuse every enquiry. Exact change, preconditions, checks and rollback: `docs/WEBSITE_SIGNING_STRICT_MODE.md`. The transitional state is now visible: System Health row *Website request signing* and `/api/health` `readiness.websiteSignature` (`not_configured` / `optional` / `required`). |
| 5 | Agent pickers (`listLeadEligibleAgents`, `listTaskEligibleAgents`) in `reference-data.ts` were callable as Server Actions by anyone with the company id and returned the staff list; `includeHidden` was caller-controlled | **Fixed and verified** | Both now require a signed-in account of **the same company**, and only an Administrator can include hidden accounts (a caller-supplied flag is ignored for everyone else). `hidden-accounts.test.ts`: cross-tenant, unauthenticated, hidden-account and `select`-shape tests. |
| 6 | `distributeNewWebsiteLead` / `distributePendingWebsiteLeads` registered as public Server Actions (found in the previous pass) | **Fixed and verified** | Previously confirmed absent from the production build's `server-reference-manifest.json`; kept by the new surface guard (below). The post-build manifest check is repeated in section 3. |
| 7 | Nothing stopped a new, unauthenticated exported function from being added to a `"use server"` file | **Fixed and verified** (preventive) | `src/__tests__/server-action-surface.test.ts`: every exported function of every `"use server"` file must show an authorization step or be on a named allow-list with a stated reason; when a production build's manifest is present it must also agree (the manifest tests are skipped, and say so, when no build exists). |
| 8 | GeoIP: production has **no City database**, so locations are country-level at best | **External infrastructure limitation** + **Owner decision required** | Prepared, not installed: read-only `geoip_data` volume into the app, an on-demand `geoip-update` job on a separate egress network with no database or secret access, directory ownership in the image, a CI smoke check, and `docs/GEOIP.md` section 2b with the exact commands, update process, rollback and accuracy limits. The licence (CC BY 4.0) is accepted by whoever runs the command. Nothing was downloaded or installed on any server. |
| 9 | GeoIP state was invisible to operators (a missing or stale file looked like "Location unavailable") | **Fixed and verified** | `getGeoIpDatabaseStatus()` (ready / stale / missing / unusable; path and records never reported), System Health row, `/api/health` `readiness.geoIpDatabase`. `ip-geolocation.test.ts` (7 status tests), `health-checks-geoip-signing.test.ts` (12), `health/__tests__/route.test.ts`. Best verified location only: nothing is invented, a stale file is still used and flagged, a non-City database is "unusable". |
| 10 | Masked-email edit gate, 13:15 `America/Los_Angeles` reveal reset, limit of five, stale tabs, DST, Admin-only IP and location, latest-sign-in retention | **Fixed and verified** (previous pass, re-run) | Re-read for regressions and re-run in the full suite; no change was needed. Source of truth: `emailRevealPeriod` in `src/lib/business-time.ts`, `assertEmailRevealedForEdit`, `docs/SECURITY_POSTURE.md` sections 7, 8 and 11. |
| 11 | Campaign limits: the application defaults (20 per minute, 400 per rolling 24 h per sending account) are **the CRM's own guard rails, not Google's limits** | **Fixed and verified** (tunability) + **Owner decision required** (the numbers) | Google's published Workspace allowance is 2,000 messages per user per rolling 24 h (500 on trial accounts, lower for unpaid new domains) and it is shared with everything the mailbox sends (`docs/COMPASS_CAMPAIGN_SENDING_CAPACITY.md` section 2, which marks what was read on Google's own page; a web search this session agreed on the 2,000 / 500 figures; Google says limits can change without notice). Before this pass the two variables could not be set on the VPS (finding 3). Nothing was raised: any change is an owner decision. |
| 12 | Campaign duplicate-send, cancellation races, unknown outcomes | **Fixed and verified** (previous pass, unchanged) | Write-ahead claim `PENDING → UNKNOWN`, quota check and claim in one transaction under a per-sender advisory lock, suppression re-read at send time, UNKNOWN never re-sent, recipient cancel is one atomic `PENDING → CANCELLED` and the worker's claim is a compare-and-swap on `PENDING`. Fake-database tests run locally; the real-PostgreSQL race tests (`campaign-and-import.integration.test.ts`, `website-signature-replay.integration.test.ts`) run in CI only. **No real email was sent in any test.** |
| 13 | Bounce / complaint handling, a sending provider, subscriber reveal flow, consent and retention policy for marketing data and lead IPs, hard delete of accounts | **Owner decision required** | Not defects: each needs a policy, a contract or a vendor. The code does not invent them. Gmail gives no bounce feedback to this path; an ambiguous outcome is shown honestly as "Outcome unknown". |
| 14 | No automatic lockout after failed sign-ins | **Not applicable (evidence)** | There is no CRM password: credentials are Google's, which applies its own protection. The failed-sign-in log is rate-folded. |
| 15 | Real MFA / Workspace 2-step verification | **External infrastructure limitation** | The CRM relies on Google sign-in; enforcing 2SV is a Workspace Admin console setting. Not verifiable from the repository. The CRM's own step-up is "recent sign-in", not MFA (`SECURITY_POSTURE.md` section 2). |
| 16 | Backup and restore | **External infrastructure limitation** / **Unverified behavior** | `deploy.sh --migrate` takes a verified backup first; scripts and procedure exist; a restore was **never rehearsed** on a real server. |
| 17 | Origin reachable only through Cloudflare | **Fixed and verified** (no published ports) + **External infrastructure limitation** (firewall) | `selfhost-deployment-config.test.ts`: no service publishes a port, the database is on an internal network, the app only `expose`s 3000, CI smoke checks nothing is published on the host. Whether the VPS firewall itself blocks direct access is not verifiable here. |
| 18 | Real Gmail send / OAuth against the live account | **Unverified behavior** | Never exercised from tests by design (no real email). Needs a controlled test by the owner. |
| 19 | Migrations `20261122000100` (default-off) and `20261122000200` (`CANCELLED`) | **Fixed and verified** (reviewed; applied by CI to an isolated database) | See section 2. |
| 20 | CSRF | **Not applicable (evidence)** to a custom gap; framework default relied on | `sameSite=lax` session cookie and Next's Server Action Origin check; no `allowedOrigins` override. Unchanged and not separately tested in this pass. |

## 2. Migration safety review

| Migration | What it does | Safe? |
|---|---|---|
| `20261122000100_account_contact_detail_edit_default_off` | `ALTER COLUMN ... SET DEFAULT false`. No row is read or rewritten; existing accounts keep their value; Administrators are never restricted by the flag (code). | Additive, instant, no lock of consequence. **Old image + new schema:** works; accounts the old image creates simply take the new default (off), which is the intended behaviour. **New image + old schema:** works but new accounts get the old default (`true`) until applied: apply before the new image serves. Rollback: `SET DEFAULT true` is the inverse, no data change. |
| `20261122000200_marketing_send_cancelled_status` | `ALTER TYPE "MarketingSendStatus" ADD VALUE IF NOT EXISTS 'CANCELLED'`. | Additive. **Order:** apply **before** the new image starts serving (`deploy.sh --migrate` does). PostgreSQL cannot remove an enum label. **Rollback caveat (stated plainly):** if the application is rolled back to the old image *after* a recipient was cancelled, a read of that row by the old image's Prisma client can fail on the unknown enum value; the old image would need the label's rows resolved first (they are cancelled, never-sent recipients). If no recipient was cancelled, the label is harmless. |

Both are forward-only and were applied by CI to an empty isolated PostgreSQL in the previous pass; they are **not applied to production** by anything here. The order in the VPS
deployment is the existing one: backup, `deploy.sh --migrate`, health check. `prisma validate` passes on the working tree.

## 3. Verification

Run on the development machine (Windows, Node 24) against the working tree before the commit:

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| ESLint on every changed source and test file | clean |
| `prisma validate` | valid |
| `npm run build` (production build, no database) | succeeded; the build's `server-reference-manifest.json` registers 159 actions, **0** `distribute*`; `server-action-surface.test.ts` (10 tests, including the manifest ones) passes against it |
| `npm audit` | 0 vulnerabilities |
| Full unit suite (`vitest run --maxWorkers=3`) | 5,374 passed, 590 skipped, **1 failed**: `campaign-builder-and-panels.test.tsx` "Save draft..." timed out at 7.1 s under the full-suite load; the same file run alone passes 16 / 16. Treated as a load-sensitive test, not a regression; it is unrelated to every file changed here. |
| Skipped | the 590 skips are the database-gated `*.integration.test.ts` suites (they need PostgreSQL; **not run on this machine**) and any manifest test without a build. They run in GitHub Actions on the pushed commit. |
| Secret scan | no key, token or credential pattern in the changed files (only the placeholder connection strings that already exist in test fixtures). `gitleaks` is not installed here. |
| Docker image build, Compose smoke test | **not run locally (Docker is not installed on this machine)**; they run in GitHub Actions. |
| Browser check | none was done in this pass. |

The unit run above also contained another session's uncommitted work in the same tree (the lead date-flexibility change); the commit does not include it, so the GitHub Actions run on the pushed commit is the authoritative result for exactly what is pushed.

## 4. What "no unresolved vulnerability" does and does not mean

No critical or high application-level vulnerability was found in the code reviewed in this pass, and the nine advisories are closed. That is a statement about the
source that was read and the tests that were run. It is **not** a penetration test, it does not cover the infrastructure items above (Workspace 2SV, firewall, backups,
Cloudflare configuration, live Gmail), and it is not a claim that none exists. Items classified *Owner decision required* or *Unverified behavior* are listed, not hidden.
