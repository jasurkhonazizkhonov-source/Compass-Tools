# Mobile usability review and fourth security pass, 2026-11-23

Branch `release/compass-tools-2026-11-22`, starting from `e132c2e` (the other session's local commit `831d87f`, date flexibility, was on top of it and is included, see section 5).
**Local inspection and automated tests only. Nothing was deployed, no production setting, secret, database or customer email was touched.**

## 1. How the mobile review was done

* A production-like local stack: the real application (`next dev`), a throw-away PostgreSQL 18 (embedded build, outside the repository) with the project's migrations and seed, fake demo data (12 leads incl. a multi-city one, contacts, subscribers, a campaign with every delivery status, a sequence with an enrollment, tasks, failed sign-ins, a note), and a signed-in **Administrator** session. Nothing in the repository, the real `.env`, or any real database was used; a gitignored `.env.local` pointed at the throw-away database.
* The in-app browser with **touch emulation** (`hover: none`, `pointer: coarse`, 5 touch points, Android user agent) at **320, 375, 768** px, plus **667x375 landscape** for the lead page and its New Lead dialog, and the desktop (1024) size for regressions. 360, 390, 414 and 430 px were **not** separately run: they fall between 375 and the widths above and share the same breakpoints (`sm` 640, `md` 768); no layout in this application changes at them.
* For every page a script measured: horizontal overflow, interactive elements that overlap or touch (gap under 4 px), controls outside the viewport, and tap targets under 24 px. Dialogs and popovers were opened and measured against the viewport. Pages with findings were then looked at in screenshots.
* **Not done:** the on-screen keyboard cannot be emulated (see the search palette below), no real phone was used, and the customer-facing quote pages (`/quote/[token]`, `/book`, `/confirmation`) and detail pages that need quotes, bookings or inquiries could not be rendered because the throw-away database had none and creating them needs the full quote flow. They are listed as not inspected.

## 2. Route inventory

Role = the lowest role that can open the page. "375 / 320 / 768" = viewports inspected.

| Route | Role | Inspected | Result |
|---|---|---|---|
| `/login` | public | 320 | fine |
| `/`, `/about`, `/contact`, `/features`, `/privacy`, `/security`, `/terms` | public | 375 (`/` signed out) | fine; footer links are 32 px tall. One cue fixed (below) |
| `/features/[slug]` | public | 375 (the slug tried returned 404) | not inspected: slug unknown |
| `/dashboard` | any CRM role | 320, 375, 768 | icon-only task link fixed |
| `/leads`, `/leads/[id]` | any CRM role | 320, 375, 768, 667x375 | edit pencils and note actions invisible on touch: fixed |
| `/contacts`, `/contacts/[id]` | any CRM role | 320, 375, 768 | same pencils: fixed |
| `/contacts/bulk-import` | any CRM role | 375 | wide editable grid scrolls sideways inside its card (by design); no change |
| `/tasks`, `/tasks/[id]` | any CRM role | 320, 375 | fine |
| `/users` | Admin | 320, 375, 768 | Name column sticky (existing); edit pencils fixed; very wide table scrolls, no change |
| `/accounts` | Admin | 375 | read-only table scrolls; fine |
| `/subscriptions` | marketing roles | 320, 375, 768 | Remove column now pinned |
| `/subscriptions/campaigns/[id]` | marketing roles | 320, 375, 768 | delivery list is already a mobile list; fine |
| `/subscriptions/campaigns/builder` | marketing roles | 320, 375 | fine |
| `/sequences`, `/sequences/[id]` | manage sequences | 320, 375, 768 | delete / unenroll actions now pinned |
| `/failed-signins` | Admin | 375, 768 | actions pinned, buttons separated |
| `/system-health` | Admin | 375 | fine |
| `/company` | Admin | 375, 768 | logo status label ran past the card: fixed |
| `/commissions`, `/salesboard` | CRM roles | 375 | period chips scroll sideways inside their bar; fine |
| `/bookings`, `/quotes` | CRM roles | 375 | **empty lists only** (no demo data); layouts with data not inspected |
| `/quotes/new` | CRM roles | 375 | answered 404 without its required parameters |
| `/quotes/[id]`, `/quotes/exchange/new`, `/bookings/[id]` | CRM roles | not inspected | need quote / booking data |
| `/crm-inquiries`, `/get-in-touch` | Admin | 375 | empty lists only |
| `/crm-inquiries/[id]`, `/get-in-touch/[id]` | Admin | not inspected | need inquiry data |
| `/quote/[token]`, `/quote/[token]/book`, `/quote/[token]/confirmation` | customer (token) | not inspected | need a real quote token |
| `/access-denied` | any | not inspected separately | redirected to the dashboard while signed in |

Shared components exercised at 320: the navigation sheet, the notifications popover, filter selects, the New Lead dialog (and its date picker at 375), Add User, New Sequence, Bulk Subscriber Import, the global search palette. All stay inside the viewport, scroll when taller than it, and have a visible close control (the search palette closes with Escape or a tap outside).

## 3. Defects found and the minimal change for each

| # | Defect (seen in the rendered app) | Cause | Change |
|---|---|---|---|
| 1 | On a phone **no lead / contact field could be edited visibly**: the edit pencils, the note Edit / Delete buttons and the Users-table pencils were invisible (opacity 0) on touch | They were revealed only with `group-hover:`, and Tailwind applies `hover:` variants only where the primary input can hover, so on touch they never appeared | added `[@media(hover:none)]:opacity-*` (and keyboard focus visibility) to `inline-edit-field.tsx`, `notes-panel.tsx`, `account-row-editor.tsx` and the marketing "Learn more" cue. Desktop behaviour measured unchanged (still hidden until hover) |
| 2 | Failed sign-ins, subscribers, sequence list and enrollments: the row actions sat 500-900 px to the right in a sideways-scrolling table; Inspect and Delete touched | wide table in a scroll container | actions column pinned to the right edge (`sticky right-0`, same technique as the Users table's sticky Name column) on those four tables; a 4 px gap between Inspect and Delete |
| 3 | Company page: the "No logo uploaded - using the default placeholder" label ran past the card's edge | non-wrapping badge in a non-wrapping row | `flex-wrap` row, label allowed to wrap (`whitespace-normal h-auto`) |
| 4 | Dashboard "My Tasks" rows: an icon-only link 14 px wide with **no accessible name** | bare icon inside a link | `aria-label` naming the task and a larger invisible tap area (`-m-2 p-2`) |
| 5 | Global search palette sat a third of the way down the screen: on a phone with the keyboard open its results would be under the keyboard | `top-1/3` at every width | `top-3` on a phone, `sm:top-1/3` unchanged from `sm` up (keyboard behaviour could not be emulated; this is the expected cause, not a proven one) |

Reviewed and deliberately **not** changed: the row checkboxes are 16 px but already carry a 40x32 invisible hit area; the admin "Signer IP addresses are not being recorded" notice is tall on a phone but is a deployment warning shown only to Administrators when `TRUSTED_PROXY` is unset; inline-edit text buttons on the Users page are 20 px high (admin-only, and they are text); the "Open System Health" link in that notice is 15 px high.

No existing control was duplicated, no component, dependency, table or migration was added for this.

Regression guard: `src/__tests__/mobile-usability-guards.test.ts` (11 tests) fails if a hover-only control is added without a touch escape (it scans every `.tsx` file, so it also protects future code), if the four tables lose their pinned actions, and for defects 3-5 and the checkbox hit area. The repository has no browser test tooling and CI has no browser job; adding Playwright was not justified for these defects, so **there is still no automated rendered-layout test in CI**.

## 4. The intermittent `campaign-builder-and-panels.test.tsx` failure

* The failing run: "Save draft sends the design..." took 7.1 s inside a 836 s full-suite run (3 workers); the failure was `expected vi.fn() to be called ... Number of calls: 0`. In isolation the test takes 0.27 s and passed 16 / 16 repeatedly, and also with 40 busy processes competing for 12 cores. **The failure was not reproduced.**
* Reading the component: the Save draft button is disabled while the save transition is pending (`disabled={pending}`), and the test clicked it a second time as soon as the error toast was seen. The toast is fired inside the transition, before React has committed its end; a click on a still-disabled button does nothing, the second save never reaches the mock, and `replace` is never called. That matches the failure signature. In idle runs the button is already enabled when the toast is seen (probed three times), so the window is not observable unloaded.
* Conclusion: a **race in the test's own sequencing**, exposed by load; **not** an application defect (a disabled button while saving is the intended behaviour). The test now waits for the button to be enabled again before the second click. Classified: test defect, *hypothesis consistent with the evidence, not reproduced*.

## 5. Other session's work included in this push

`831d87f` "Date flexibility" (written and tested by the other session, committed locally before this pass; **never pushed**): a nullable `Lead.dateFlexibilityDays` with a CHECK 0-3, migration `20261123000100_lead_date_flexibility_days` (additive, no row rewritten), intake accepts `dateFlexibilityDays`, shown on the lead page and in two e-mails. I reviewed its diff and its tests ran in every run of this pass. **It adds a database migration and changes the website API contract** (a new accepted field): deploy order is CRM first, with the migration applied before the new image serves, and the website after. It is included because it is committed work on this branch; if you do not want it released, say so before the push is deployed.

## 6. Security re-verification (fourth pass)

| Area | Result |
|---|---|
| Dependencies | `npm audit` 0 (also `--omit=dev`); overrides are `effect` 3.22.5, `glob` 14.0.6 (only under `@opennextjs/cloudflare`), `ts-morph` 28.0.0 (only under `shadcn`): stable releases, used by build / CLI tooling that is not copied into the runtime image (the Dockerfile's runner stage copies the traced standalone output, `@img` and two scripts; the CI Docker job builds it). Guard test unchanged and passing. `npm audit fix --force`, prereleases and broad upgrades were not used. |
| Website boundary | Every route that accepts website traffic goes through the signature guard: flight-inquiries, contact-inquiry (through `public-inquiry.ts`, `serverToServer`), subscribe, lead-capture. The CRM's own browser form (`crm-inquiry`) is deliberately outside it. Replay, expiry, tamper, v1 downgrade, key rotation and idempotency are covered by `website-request-signature.test.ts`, `lead-capture/__tests__/signature.test.ts` and the real-PostgreSQL `website-signature-replay.integration.test.ts`. Strict mode remains an **owner decision**: `docs/WEBSITE_SIGNING_STRICT_MODE.md`. |
| Compose forwarding | `compose-env-propagation.test.ts` and the CI smoke step (both passed in CI run 15) check names against the code that reads them; empty values mean the code default; no secret is printed by `/api/health` (category-only fields; tested). |
| Server Actions | The guard was **tightened**: it used to count `checkPublicRateLimit` (a rate limiter, which says nothing about who is calling) as an authorization marker, so `submitBooking` and `confirmCancellationByCustomer` passed without being on the public-by-design list. The marker is removed and both are listed with their reason (the quote's secure token is the credential). 79 exported actions have no direct `getCurrentAccount` in their own body; each was either a listed public-by-design entry or reaches a checked helper (`assertAdmin`, `assertMarketingAccess`, `authorize`, `loadForRecovery` -> `assertSequenceAccess` / `assertLeadAccess`, `transition` -> `assertMarketingAccess`), read by hand this pass. The allow-list has 18 entries, each with a reason. |
| IP / GeoIP | Full sign-in IP and location pages are Administrator-only (`canManageAccounts` = ADMIN; failed sign-ins `notFound()` for anyone else; the account query selects the IP only for that page). Country-only results are not shown as city-level (previous pass); a missing or stale database fails safe (status row, country-level locations). Production GeoIP is **not installed**; `docs/GEOIP.md` 2b has the procedure. A location is an estimate from the network, never a position. |
| Campaign / subscriber | Unchanged and re-run: duplicate-send protection, individual cancellation race, unknown outcomes never resent (unit tests locally; real-PostgreSQL race tests in CI and, this pass, locally - section 7). Bounce handling, subscriber reveal, retention and consent policy, a sending provider: **owner decisions**, nothing invented. |
| External | Workspace 2-step verification, VPS firewall, Cloudflare-only origin access, backup restore, real Gmail delivery, production GeoIP: **not verifiable from the repository**; nothing was changed or claimed. |

## 7. Verification

Run on the development machine (Windows, Node 24) against the working tree that is committed:

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| ESLint on every changed file and all of `src/components` | clean |
| `prisma validate` | valid |
| `npm run build` | succeeded (no database); manifest: 159 registered actions, 0 `distribute*`; `server-action-surface.test.ts` 10 / 10 against it |
| `npm audit` and `--omit=dev` | 0 vulnerabilities |
| Full unit suite (`--maxWorkers=3`) | **5,386 passed, 592 skipped, 0 failed** (357 files passed, 31 skipped). The 592 skips are the database-gated suites, run next. The previously flaky test passed. |
| **Real-database integration suites, run locally this pass** | **32 files, 624 passed, 1 skipped, 0 failed**, serially (`--no-file-parallelism`), against a throw-away PostgreSQL **18.7 (embedded build)** with TLS (`sslmode=require`, self-signed certificate trusted via `NODE_EXTRA_CA_CERTS`), database `compass_test`, all migrations applied including `20261123000100`. CI uses PostgreSQL 17 in Docker; the GitHub Actions run on the pushed commit is the authoritative result for that version. |
| Mobile rendered checks | by script and screenshot in the touch-emulating browser (section 1); **not** an automated CI test |
| Secret scan | pattern scan of the changed files; `gitleaks` is not installed here |
| Docker image build, Compose smoke test | **not run locally (Docker is not installed on this machine)**; they run in GitHub Actions |
| Not verified | the on-screen keyboard, a real phone, the customer quote pages and pages that need quote / booking / inquiry data (section 2) |
