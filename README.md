# Compass Tools CRM

A travel-agency CRM built on Next.js (App Router) and PostgreSQL (via Prisma).
Covers the full agency workflow: lead capture and distribution, contact
management, itinerary building (manual entry, Sabre/SWAN, Apollo), quoting,
customer-facing booking/exchange/cancellation flows, ticketing, Gmail-based
email (direct sends and automated sequences), and role-based CRM
administration.

Compass Tools is deployed **once per company**, each with its own dedicated
PostgreSQL database — there is no shared database or in-app tenant switch.

## Local development

```bash
npm install
cp .env.example .env   # then fill in real values — see below
npx prisma migrate deploy
npx prisma generate
npm run dev
```

Local development can leave `TRUSTED_PROXY` and `CRON_SECRET` unset — see
`docs/DEPLOYMENT.md` for what that means and when it's no longer safe.

## Environment variables

See `.env.example` for the full list with generation instructions, and
`docs/DEPLOYMENT.md` for a complete deployment walkthrough (provisioning a
database, required Google OAuth setup, the production bootstrap process,
and Vercel-specific configuration).

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Local development server |
| `npm run build` | Production build (runs `prisma generate` first via `postinstall`) |
| `npm start` | Run a production build |
| `npm test` | Run the test suite (Vitest) |
| `npm run lint` | ESLint |
| `npx prisma migrate deploy` | Apply migrations to the target database (production-safe — never `migrate dev` against a real deployment) |
| `npx tsx prisma/bootstrap-company.ts ...` | One-time setup: creates the company row and its first Admin account. See the script's own header comment. |

## Documentation

- `docs/DEPLOYMENT.md` — full deployment walkthrough (database, environment
  variables, Google OAuth, bootstrap, Vercel cron/config).
- `docs/PAYMENT_AUTOFILL_SECURITY.md` — why full card-number autofill is
  intentionally not implemented, and what a compliant version would require.
- `docs/ip-vault-compliance.md` — data-retention/legal considerations for
  the booking-submission IP capture feature.
- `docs/ip-vault-fraud-runbook.md` — how to investigate a suspected
  fraud/chargeback case using the captured submission IP data.
