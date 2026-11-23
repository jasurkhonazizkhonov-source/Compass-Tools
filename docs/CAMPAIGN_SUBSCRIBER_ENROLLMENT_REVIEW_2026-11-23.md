# Campaign, subscriber and sequence-enrollment review; mobile regression; security reassessment (2026-11-23, second pass)

Branch `release/compass-tools-2026-11-22`, starting at `9e22da9`. Local inspection, local tests and CI only. **Nothing was deployed, migrated, installed or reconfigured on any production system, no secret was generated or rotated, no real e-mail was sent.**

## 1. State check

The five commits named in the brief are on the branch exactly as reported: `831d87f` date flexibility, `d1fce25` mobile touch fixes, `8933958` test race fix and tightened Server Action guard, `c40cfbc` mobile and fourth-pass docs, `9e22da9` sign-in context test fix. `origin/release/compass-tools-2026-11-22` was `9e22da9`, `main` `5a77976`, the working tree clean apart from the two protected untracked paths and the dev-server-generated `AGENTS.md`.
`docs/FINAL_IMPROVEMENTS_AND_SECURITY_REVIEW_2026-11-23.md`, named in the brief, **does not exist** in the repository or its history; the nearest documents read were `docs/MOBILE_USABILITY_AND_FOURTH_PASS_2026-11-23.md`, `docs/SECURITY_REMEDIATION_THIRD_PASS_2026-11-22.md`, `docs/SECURITY_POSTURE.md`.

## 2. New Campaign: one entry point, the latest builder

Searched the whole source tree, not only the Campaigns page.

* The label "New Campaign" is rendered in **one** place, `src/app/(crm)/subscriptions/page.tsx`, a link to `/subscriptions/campaigns/builder` (the block-based builder with templates, preview, Save draft, Send test). Seen in the browser at 320 and 375 px: one button, beside the "Marketing Campaigns" heading, nothing overlapping.
* There is no `campaigns/new` route, no other link to a blank builder, and no modal. The older HTML form (`CampaignForm`) is rendered only on the existing campaign's own page (`campaigns/[id]`, always with a saved `campaignId`) as the editor/viewer of that campaign; it is not a way to create one. Its `createMarketingCampaign` branch is therefore unreachable from the UI but is still covered by the HTML-lifecycle tests, and was **not removed** (the brief forbids deleting shared code merely because its button is gone).
* Authorization: the builder page returns 404 for anyone without `canViewSubscriptions`; every exported action in `campaign-delivery.ts` and `marketing-campaigns.ts` calls `assertMarketingAccess` (directly, or through `transition`), now asserted by test.
* Result: **no change was needed**; the earlier cleanup was already complete. New guard: `src/__tests__/campaign-subscriber-enrollment-surface.test.ts`.

## 3. Subscribers: Import Contacts removed, bulk email import retained

* No "Import Contacts", "Import subscribers", CSV subscriber import component or route exists in the application (asserted by test). The retained feature is **Add Bulk Subscribers** (paste many addresses, preview, then commit), one button in `subscriber-list.tsx`, one dialog mount. Seen in the browser: one such button, zero other import buttons.
* Validation, duplicate handling and suppression live in `subscribers.ts` (`previewBulkSubscribers`, `createBulkSubscribers`), both behind `assertMarketingAccess`; their tests ran in every run of this pass.
* **Not removed:** the sidebar's **Bulk Contacts** (`/contacts/bulk-import`) is the CRM's contact import, a different feature ("no unrelated contact-management functionality"); the `SubscriberImportJob` table remains in the schema although no code uses it (dropping it needs a migration, which the brief does not authorise; listed under owner decisions).

## 4. Sequence enrollment notification: not found, awaiting the exact screen

**What I traced.** Every enrollment surface in the code:

1. the lead page's **Sequences tab** (`LeadSequencesPanel` -> `ActiveSequenceCard`, with the status badge, "Enrolled ... by ...", step line and **Unenroll**), inside the existing tabbed card;
2. the bulk **Add to sequence** dialog opened from the Leads and Contacts lists (a dialog, plus a toast);
3. the sequence's own **Enrolled leads** table (with Unenroll);
4. a **toast** after a lead is enrolled ("... started - the first email is scheduled ...").

There is **no banner or panel about enrollment in the main Lead or Contact layout**: the lead page's main grid (`lg:grid-cols-[360px_1fr]`: info cards on the left, tabbed card on the right) contains nothing about enrollment outside the Sequences tab, and the Contact page has no sequence or enrollment UI at all (contacts are enrolled from the list, through their most recent lead). Git history shows no such banner having existed either (searched all of `src` and `git log -S`). The only things that resemble "a large notification" are the success **toast** (top-right, a long sentence, a few seconds) and the **Sequences-tab card** itself.

**What I did not do.** The brief asks me to remove something I cannot find, and to avoid inventing a replacement, a second Unenroll button or a layout change. So **no code was changed for this item**, and I added a guard test that pins the current arrangement (Unenroll and the active-enrollment card are rendered only from the lead's Sequences panel and the sequence's table; nothing about enrollment is rendered outside the lead page's Sequences tab; the contact page has none; the apply dialog adds no page-level banner). **Needed from you:** which screen shows the large notification (a screenshot or the exact steps), or whether the toast or the Sequences-tab card is what is meant. I will then make the smallest change in that component.

## 5. Mobile regression review

Re-inspected with touch emulation at 320 and 375 px (Subscriptions, campaign builder, Leads, lead page and its Sequences tab, Contacts, Sequences, the sequence page, failed sign-ins), with 768 and desktop re-checked in the previous pass; the 768 and desktop widths were **not** re-run in this pass for pages whose code did not change.

* The previous fixes hold: hover-only controls are visible on touch, the pinned actions on failed sign-ins, subscribers and the sequence list, no horizontal page overflow, no overlapping controls on the pages above.
* **Regression found and fixed (mine, from `d1fce25`):** on the **sequence page's Enrolled leads table** the pinned Actions cell covered the lead's name at 320 px, and that cell holds Unenroll *plus* the recovery buttons and, after a failed retry, a whole Gmail problem notice, so it could cover most of the table. Pinning was **reverted for that one table** (restored to its previous markup); the other three pinned tables hold only small fixed controls. `mobile-usability-guards.test.ts` now asserts that table is not pinned. Cost: on a phone the Unenroll button of that table is again reached by scrolling the table sideways; the lead page's Sequences tab (where staff normally unenroll) shows it without scrolling.
* Still true and unchanged: row checkboxes are 16 px with a larger invisible hit area; the admin "Signer IP addresses are not being recorded" notice is tall on a phone (shown only to Administrators when `TRUSTED_PROXY` is unset, as in the local test setup).
* Not covered: a physical device, the on-screen keyboard, screen-reader behaviour, and pages that need quote, booking or inquiry data.

## 6. Security reassessment (source and tests; not a penetration test)

| Item | Finding this pass |
|---|---|
| Cron authentication | `rejectUnauthorizedCron` fails closed (503 without a secret in a production-class environment, 401 otherwise, constant-time compare) and is used by all four cron routes. It had **no direct test**; `cron-auth.test.ts` (8 tests) now covers production, preview, development, whitespace secrets, wrong / missing / altered headers and `hasValidCronSecret`. Two route comments that said the route "stays open" without a secret were wrong for production and were corrected. |
| `submitBooking`, `confirmCancellationByCustomer` | Both look the quote up by its unguessable `secureToken` before doing anything, refuse canceled quotes, are rate limited, and only the same signer can replay a booking (read in `booking.ts` / `cancellation.ts`). They are listed as public by design in the surface guard. |
| Server Action guard | The allow-list has 18 entries, each with a reason; the manifest-based half passes against the new build (159 registered actions, none `distribute*`). |
| Enrollment / Unenroll | `unenrollLead` requires the signed-in account, sequence access and lead access, answers a missing and a foreign enrollment identically, and only changes an ACTIVE row (tests: `sequences.test.ts`, including the role / owner refusal and both race cases). Starting a sequence and the bulk enroll re-check the account and access on the server. |
| Campaign and subscriber import permissions | every action asserts marketing access (asserted by `campaign-subscriber-enrollment-surface.test.ts`). |
| Website signing | unchanged and re-run: all four website routes behind the guard; strict mode remains an owner decision (`docs/WEBSITE_SIGNING_STRICT_MODE.md`). |
| Full sign-in IP | Administrator-only (previous pass; tests re-run). |
| Dependencies | `npm audit` 0 (also `--omit=dev`). |
| Secrets | no secret scanner is installed here (no `gitleaks`, `trufflehog` or `detect-secrets`); installing one means downloading a binary, which was not authorised. A pattern scan over **every tracked file** (private keys, AWS, GitHub, Slack, Anthropic, Stripe-style, Google API keys and OAuth client ids) found nothing outside docs and test fixtures; no `.env`, `.pem`, `.key` or credentials file is tracked; the CI static job has its own secret-hygiene step. |
| Date flexibility | `Lead.dateFlexibilityDays`, migration `20261123000100`, the API field, the e-mail and lead-page display and the older-form compatibility (a request with only `datesFlexible` stores "not stated") are intact: their unit tests and the two real-PostgreSQL cases passed in this pass. Nothing was applied to any production database. |

## 7. What remains (owner decisions and external work)

* **Strict website signing** - owner decision; preconditions and rollback in `docs/WEBSITE_SIGNING_STRICT_MODE.md`.
* **Production GeoIP database** - not installed; the procedure is in `docs/GEOIP.md` 2b and needs your approval.
* **Bounce and complaint handling, sending provider and capacity, retention and consent policy** - owner decisions; nothing was invented.
* **`SubscriberImportJob` table** - unused; dropping it needs a migration and your approval.
* **Workspace two-step verification, VPS firewall, Cloudflare-only origin access, backup restore rehearsal, real Gmail delivery** - external; cannot be verified from the repository.
* **Physical-device and screen-reader checks**, and a rendered-layout test in CI (the repository has no browser test tooling; adding one needs a decision).
* **Push safeguard** - see section 8.

## 8. Verification

Run on the development machine (Windows, Node 24) against the working tree that is committed:

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| ESLint (new and changed tests, `src/server/security`, `src/app/api/cron`, `src/components/sequences`) | clean |
| `prisma validate` | valid |
| `npm run build` | succeeded; manifest: 159 registered actions, 0 `distribute*`; `server-action-surface.test.ts` 10 / 10 against it |
| Full unit suite (`--maxWorkers=3`) | **5,404 passed, 592 skipped, 0 failed** (359 files passed, 31 skipped); no intermittent failure this time |
| Real-database integration suites (local, serial, throw-away PostgreSQL 18.7 with TLS) | **32 files, 624 passed, 1 skipped, 0 failed**. CI uses PostgreSQL 17 in Docker. |
| New / changed tests | `campaign-subscriber-enrollment-surface.test.ts` (10), `cron-auth.test.ts` (8), `mobile-usability-guards.test.ts` (11) |
| Campaign creation, subscriber bulk import, enrollment and Unenroll regression tests | part of the suites above (`campaign-builder-and-panels`, `campaign-form-starters`, `marketing-campaigns-html-lifecycle`, the subscribers and bulk-subscriber tests, `sequences.test.ts`, `active-sequences`, `lead-and-sequence-consistency`, `sequence-enrollments-table`) - all passed |
| `npm audit` | 0 vulnerabilities |
| Secret scanning | pattern scan only (no scanner installed, see section 6) |
| Mobile rendered checks | by script and screenshot in a touch-emulating browser (section 5); not an automated CI test |
| Docker image build and Compose smoke test | **not run locally (Docker is not installed on this machine)**; they run in GitHub Actions |
| GitHub Actions on the pushed commit | see the final report |

## 9. Pushing

The repository's `remote.origin.pushurl` is `DISABLED-NO-PUSH` and was not touched. See the final report for what happened when a normal `git push origin` was attempted.
