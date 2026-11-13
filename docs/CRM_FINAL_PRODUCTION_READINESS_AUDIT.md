# CRM Final Production Readiness Audit

Date: 2026-11-13. Target: `compass-tools-updated`. **Verdict: NOT proven ready for production.** The code, type-check, lint, unit/route tests, schema validation and the standalone build are clean, but the database-backed behaviour, the Docker image, the scheduler for sequences and several owner decisions are unverified. Production was not deployed, contacted or modified by this work.

## 1. Verification run (this task)

| Check | Result |
| --- | --- |
| `tsc --noEmit` | clean |
| `eslint .` | clean |
| `prisma validate` | schema valid |
| Vitest (full) | 4,224+ passed, 0 failed; 1,099 skipped - every skipped test is a database-gated integration suite (needs `INTEGRATION_DATABASE_URL`); final numbers are in the GitHub release report |
| Standalone build (`NEXT_OUTPUT=standalone npm run build`, dummy unreachable `DATABASE_URL`) | succeeds; `server.js` boots; pages needing the database return 500 because the database is unreachable (expected); `/api/health` did not answer within 10 s while the database connection retried |
| Docker image build / compose run | **not performed** (Docker is not installed here) - nothing about the image is claimed |
| Original CRM and both website originals | byte-identical to their baselines (SHA-256, 1,378 and 1,122 files, 0 differences) |
| Secret scan of everything that would be committed (998 files) | no real secrets; only throwaway literals in unit tests (reviewed); no `.env` file in the tree |
| Port 3001 | a stale Next dev server (pid 9836, started 06:54 today from this project) still listens and answers 500; it was inspected and **not** stopped, restarted or modified. It is not part of any release |

## 2. Security and privacy review (summary)

Positive: bearer-key website API with private-network-only refusal, constant-time secret comparisons, bounded body reads on every public endpoint, signed visitor context with a 300 s window, rate limits and audit, CSP nonce and security headers, append-only audit log, step-up for privilege grants, CVV never persisted, card vault opt-in with versioned key ring, IP vault encrypted, location approximate and coordinate-free, health endpoint minimal when anonymous, `poweredByHeader` off.

Findings (none newly introduced by this task):

1. **Privacy-policy mismatch** - the website policy mentions IP collection for flight requests only; the CRM can also record IP/approximate location for contact-form inquiries and sign-ins. Align the policy text (owner/legal).
2. **Lead IP reveal grant model** is wider than "Administrator only" (Admin or granted Manager/Ticketing, audited, recent login required). Confirm this is intended.
3. **Latitude/longitude** deliberately not stored (policy kept although the request allowed them "if useful").
4. **Origin exposure**: `CF-Connecting-IP` is trusted in the `cloudflare` mode; the app must be reachable only through the tunnel (documented, enforced by compose having no published port).
5. **Sequence automation not scheduled** in the VPS deployment (pre-existing): enrolled leads would never be emailed until a scheduler calls `/api/cron/sequences`.
6. Dependency state: Next 16.4.6, nodemailer 10.x, zod 4.6.x, sanitize-html - carried from earlier approved upgrades; no dependency was changed in this task.

## 3. Blockers before any production use

| ID | Blocker | Owner action |
| --- | --- | --- |
| B-1 | Database integration suites never ran against PostgreSQL in this environment | run them in CI (PostgreSQL service) or a disposable local server; do not point at production |
| B-12 | The disposable-database guard requires a loopback `inet_server_addr()`; a Docker-hosted CI database may be refused; the guard was **not** weakened | decide how CI should satisfy it |
| B-2 | Docker image and compose stack never built/run here | run the CI smoke job or build on a Docker host |
| B-3 | Sequence sweep not scheduled | add a scheduler call or enable it in the poller |
| B-4 | Live VPS stack does not match any pushed branch (`docs/` live-vs-git note) | reconcile before `deploy.sh` |
| B-5 | `origin` push URL is disabled; commit identity unset | owner decision (a review branch was pushed with an explicit URL, see the release report) |
| B-6 | Policy decisions: privacy text, reveal grants, coordinates, "Vercel" label on signed context locations | owner |

## 4. What was not done on purpose

No production deployment, VPS access, migration, environment or credential change, PostgreSQL installation or database creation, Docker run, force-push, history rewrite, stash deletion, repository clean/reset, or additional clone/worktree. A separate explicit approval is required to deploy.
