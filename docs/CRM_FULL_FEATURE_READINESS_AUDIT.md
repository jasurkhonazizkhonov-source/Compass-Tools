# CRM Full Feature Readiness Audit

Date: 2026-11-13. Scope: `compass-tools-updated` (the original `compass-tools` is reference-only and byte-identical to its baseline; re-verified by SHA-256 of all 1,378 files). No PostgreSQL, Docker, Gmail, Cloudflare or production system was used, so many items can only be classified as mock-tested.

## Classification key

| Label | Meaning |
| --- | --- |
| **VW** Verified working | exercised by passing automated tests that do not depend on a database or external service, and read in code |
| **VWL** Verified working with limitations | as VW, with a stated limit |
| **MT** Mock-tested only | passes against a fake/mocked Prisma or provider; real behaviour not observed |
| **DB** Requires database verification | an integration suite exists but is skipped without a disposable PostgreSQL (`INTEGRATION_DATABASE_URL`) |
| **EXT** Requires external service verification | needs Gmail / Cloudflare / DNS / a browser against a live deployment |
| **DEF** Defective | a defect was found (fixed items say so) |
| **NI** Not implemented | |

Automated evidence for the whole tree at this commit: `tsc --noEmit` clean, `eslint .` clean, `prisma validate` valid, Vitest 4,224 passed / 0 failed / 1,099 skipped (all skipped tests are database-gated integration suites), standalone `next build` succeeds and `node server.js` boots (login returned 500 only because the dummy database was unreachable).

## Matrix

| Area | Feature | Status | Evidence / limitation |
| --- | --- | --- | --- |
| Auth | Sign-in, session gate (`proxy.ts`), single-device sessions, sign-out-all | MT + DB | `session-enforcement-coverage`, `proxy` tests; `session-lifecycle.integration` skipped |
| Auth | Google/Gmail connect, re-authorisation | EXT | needs real Google OAuth |
| Auth | Last sign-in IP/location (Users page, Admin-only) | VWL / DB | IPv4/IPv6 + Cloudflare/Vercel/local-DB locations tested with mocks; no MMDB file shipped; DB columns unverified |
| Roles | Role checks, visibility (Admin/Manager teams/Agent/Ticketing) | MT + DB | `visibility`, `permissions` tests; manager-team integration skipped |
| Leads | Create from website API/lead-capture, list, filters, detail, status, assignment, queue/pickup | MT + DB | route + action tests; `lead-queue`, `lead-capture` integration skipped |
| Leads | Lead submission info (masked IP, audited reveal) | VWL / DB | reveal grant model is Admin **or granted** Manager/Ticketing (policy decision) |
| Leads | Itinerary/multi-city, Updated flag, notes, tasks | MT + DB | unit tests pass |
| Leads | Bulk selection, bulk add-to-sequence, Admin-only bulk delete | MT + DB | `bulk-selection` unit + integration (skipped) |
| Contacts | Contacts, reassignment, resolution, payment methods | MT + DB | |
| Inquiries | Website flight request API | VW (contract) / DB | 26 route tests; idempotency concurrency needs DB |
| Inquiries | Contact-form inquiries, IP/location, Admin reveal | MT + DB | |
| Quotes | Quote create/send, airline confirmation, airline history | MT + DB / EXT (email) | |
| Bookings | Booking submit, card vault, CVV transient handling, exchange, cancellation | MT + DB | CVV never stored (tests); vault needs `CARD_VAULT_MODE`; integration skipped |
| Commissions / Salesboard | Reports, pay-period | MT + DB | `pay-period-reporting.integration` skipped |
| Sequences | Create/edit, enroll, status-enroll, duplicate protection, scoping | MT + DB | see sequence report |
| Sequences | Step execution, delay, retry, claim lease | MT | |
| Sequences | **Active/Inactive switch stopping sends** | **DEF - fixed** | previously cosmetic; now enforced and tested |
| Sequences | Scheduling of the sweep in the VPS deployment | **DEF (pre-existing, not changed)** | nothing calls `/api/cron/sequences` on a schedule |
| Sequences | Per-enrollment pause/resume; time-zone / business-hours sends | NI | |
| Tasks | Tasks, due-task notifications, in-process poller, `DISABLE_IN_PROCESS_POLLER` | VW (poller) / MT | 16 new poller tests |
| Marketing | Campaigns, HTML sanitiser, starters, subscribers, unsubscribe (+reason) | VW (sanitiser/fixtures) / MT / EXT (delivery) | 16 HTML fixture tests |
| Email | Gmail sending, MailComposer, Bcc handling, templates | MT + EXT | no real mail sent |
| Attachments | Local-disk uploads, permissions | VWL / DB | local storage tests partly platform-conditional; R2 removed |
| System | System-health page, `/api/health` (minimal anonymous, detail with cron bearer), cron routes' auth | VW (auth) / DB | |
| Security | Security headers/CSP nonce, body-size limits on public endpoints, rate limiting, audit log append-only, step-up for privilege grants | VW / MT | many unit tests; audit integrity needs DB |
| Reference data | Airports/airlines search | MT + DB | `reference-data` needs `DATABASE_URL`; some tests skipped |
| Deployment | Dockerfile, compose, deploy scripts, CI workflow | **Not run** | no Docker here; CI smoke job is the proof |
| Deployment | Standalone Next build + boot | VWL | built and booted without a database |

## Defects found in this task

1. IPv6 validation/canonicalisation (fixed) - see the IP report.
2. Sequence Active/Inactive switch not enforced (fixed) - see the sequence report.
3. Sequence sweep not scheduled in the deployment (pre-existing; documented, needs a decision).
4. Test-only: a lint violation (`any`) in the new route test (fixed).

## Open items that no test can close here

- Run the database integration suites against a **disposable** PostgreSQL (CI does this; locally the safety guard demands a loopback server and the Docker-hosted CI database may be refused - decision B-12 in `docs/CRM_FINAL_RELEASE_BLOCKERS_2026-11-13.md`).
- Build and run the Docker image; deploy only after separate approval.
- Real Gmail send, real Cloudflare headers, real MMDB lookup.
