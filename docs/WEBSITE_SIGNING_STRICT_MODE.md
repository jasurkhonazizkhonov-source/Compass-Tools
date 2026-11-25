# Website request signing: mandatory in production (runbook)

**Status of this document (2026-11-25): the code enforces it; nothing described here has been done on production.** The production `.env`, the VPS and the live
website were not touched or inspected. The signature format is specified in `docs/WEBSITE_LEAD_API.md` ("Request signature v2"); this file is the policy, the
deployment order, the checks and the rollback.

## The policy

**A production CRM accepts a website request only with a valid, single-use v2 signature.** There is no optional or transitional mode in production, and no setting
creates one (`src/server/website-signing-policy.ts`).

| Production configuration | What the website routes do | Deploy (`deploy.sh`) |
|---|---|---|
| secret set (32+ characters), `WEBSITE_SIGNATURE_REQUIRED=true` | signed accepted; everything else `401` | allowed |
| secret set, switch empty or `false` | same as above (the switch cannot turn it off) | **refused** until the switch says `true` |
| secret missing or shorter than 32 characters | **every request refused, `503`**; startup logs it, System Health is **Critical** | **refused** |

Outside production (`next dev`, tests) signatures are required only when `WEBSITE_SIGNATURE_REQUIRED=true`; with that switch and no usable secret the routes also
answer `503`. "Production" means `NODE_ENV=production`, `APP_ENV=production` or a Vercel production/preview deployment (`src/lib/env.ts`), so a local `next start`
is production too.

The guarded routes:

| Route | Notes |
|---|---|
| `POST /api/v1/website/flight-inquiries` | also needs the bearer key and the private network (unchanged) |
| `POST /api/public/contact-inquiry` | |
| `POST /api/public/subscribe` | |
| `POST /api/public/lead-capture` | the updated website does not call it |

The CRM's own contact form (`/api/public/crm-inquiry`, a visitor's browser) is not a website server call and is not signed.

A refused request stores nothing (no lead, contact or subscriber) and records no signed visitor facts. `401` answers say only "Invalid request signature"; `503`
says the service is temporarily unavailable. The log has a fixed tag (`[website-signature] refused: <reason>`), never the signature, context, nonce, body or an IP.

## The deployment gate

`deploy/deploy.sh` builds the new image and then runs, inside it, before any migration or restart:

```bash
docker compose run --rm --no-deps -T app node scripts/website-signing-preflight.mjs
```

It refuses when: the secret is missing, short, contains whitespace or looks like a placeholder; `WEBSITE_SIGNATURE_REQUIRED` is not exactly `true`;
`LEAD_INGEST_SECRET_PREVIOUS` is set but short or equal to the current secret; or either secret is reused as another credential (API key, cron secret, Google client
secret, an encryption or hashing key). It prints variable names and rules, never values. `deploy/verify.sh` fails if the running app does not report
`websiteSignature=required`. CI (`deploy/ci-smoke.sh`) proves both against a real container.

## Deployment order: this release changes it

Earlier releases deployed the CRM first in a transitional mode that accepted unsigned requests. **That mode no longer exists in production**, so from the moment
this CRM is live, anything that posts to the routes above without a v2 signature is refused.

### Before deploying the CRM

* [ ] **Find out how the live website delivers enquiries today** (not verified from here). If it calls any route above without a v2 signature, those enquiries are
      refused from the CRM deploy until the new website is live. Deploy the two back to back in a quiet period; the new website keeps the visitor's typed form on an
      error. If the live website writes to the database itself, or already signs v2, there is no gap.
* [ ] No other caller of `/api/public/lead-capture` in the last 30 days of Cloudflare/app logs (it would be refused).
* [ ] A new random `LEAD_INGEST_SECRET` (`openssl rand -base64 32`), kept in the password manager, for **both** `.env` files.
* [ ] CRM `.env`: `LEAD_INGEST_SECRET=<value>` and `WEBSITE_SIGNATURE_REQUIRED=true`.
* [ ] Website `.env`: the same `LEAD_INGEST_SECRET`, plus `CRM_COMPANY_ID` (the signature binds the company). The website's preflight refuses without them.
* [ ] Both servers' clocks synchronised: a signature is accepted for 120 seconds after signing and 30 seconds ahead.

Never paste the value into a chat, ticket or commit.

### After deploying the CRM, then the website

* `bash deploy/verify.sh` reports `websiteSignature=required`; the System Health row **Website request signing** is Healthy.
* From a machine on the private network an unsigned `POST /api/public/subscribe` answers `401` `{"ok":false,"error":"Invalid request signature."}`.
* Submit one real enquiry, one contact message and one newsletter sign-up from the website: each arrives once, and the enquiry shows the visitor IP and location.
* Watch the app log for `[website-signature] refused:`. A stream of `expired` or `future` means clock drift; `no signature` means a caller that does not sign;
  `replay` means one signed request was sent twice (an attacker, or a proxy re-sending).

## Roll back

There is no switch that re-opens unsigned requests in this release; that is deliberate.

* **Signed requests refused** (`401`/`503`): fix the cause. Compare the two secrets (re-enter both from the password manager), check the company id and the
  clocks, then `docker compose up -d app` (a plain `restart` does not re-read `.env`). The website's visitors see an error and keep what they typed meanwhile.
* **The release itself must go back**: `bash deploy/rollback.sh <previous version>` (read its migration warning first). The previous image honours
  `WEBSITE_SIGNATURE_REQUIRED`: leaving it `true` keeps strict mode; emptying it on that **older** image accepts unsigned requests again, which is a security
  step back that needs an explicit owner decision. `verify.sh` reports it as a failure.

## Rotating the secret

Put the new value in `LEAD_INGEST_SECRET` and the old one in `LEAD_INGEST_SECRET_PREVIOUS`, `docker compose up -d app`, deploy the new value to the website, then
empty `LEAD_INGEST_SECRET_PREVIOUS` and recreate again. Both are compared in constant time and neither is logged.

## What was verified, and what was not

Automated tests cover signed, unsigned, v1, tampered (method, path, company, body), expired, future-dated, replayed, wrong-secret, previous-secret and malformed
requests; production with the switch empty or `false`; a missing or short secret; the one-time nonce against real PostgreSQL
(`website-signature-replay.integration.test.ts`); the pre-flight rules and its place in `deploy.sh`.

**Not verified: any production configuration, and a submission from the production website to the production CRM.** Both need the deployment.
