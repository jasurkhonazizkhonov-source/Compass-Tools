# Website request signing: enabling strict mode (runbook)

**Status of this document (2026-11-22): a prepared procedure. Nothing described here has been done on production.** Strict mode is OFF unless the owner
turns it on. The mechanism, the signature format and the rollout order are specified in `docs/WEBSITE_LEAD_API.md` ("Request signature v2"); this file is only
the exact switch-over, the checks to run before and after it, and the rollback.

## What strict mode changes

Strict mode = `LEAD_INGEST_SECRET` (at least 32 characters) is set **and** `WEBSITE_SIGNATURE_REQUIRED=true`. Then every request to these four routes must carry a
valid, single-use v2 signature, or it is refused with `401` **before anything is stored** (no lead, no contact, no subscriber, no rate-limit counter):

| Route | Notes |
|---|---|
| `POST /api/v1/website/flight-inquiries` | also needs the bearer key and the private network (unchanged) |
| `POST /api/public/contact-inquiry` | |
| `POST /api/public/subscribe` | |
| `POST /api/public/lead-capture` | guarded since 2026-11-22; before that a lead could be posted here unsigned even in strict mode (a bypass, now closed) |

Without strict mode (the transitional default) a request **with** a valid signature is verified and its signed visitor facts are used; a request **without** one
is accepted exactly as before, and no visitor IP or location is trusted from it.

## Why this was not just switched on

1. **The website must already be signing.** The updated website signs every call with v2 using the same secret (the website's signer and the CRM verifier were checked against each other by hand, including the shared
   known-answer vector). The website that is live today does not. Turning strict mode on first would make
   every enquiry fail with 401. **Order: CRM transitional, then website, then strict.**
2. **`/api/public/lead-capture` may have other callers.** Older documents say this route has "other callers". The updated website does not call it. Before strict
   mode, confirm from the Cloudflare/app logs of the last 30 days that nothing but the website's server posts to it (see "Before" below). If something does, it needs
   the signature too, or the route must be left out of the switch-over by an owner decision.
3. **Clocks.** A signature is accepted for 120 seconds after signing and 30 seconds ahead. Both servers must keep NTP time. A drifting clock turns into 401s.

## Before (all must be true)

* [ ] The website that is **live** signs with v2 (its deployment includes the signing change) and holds the same `LEAD_INGEST_SECRET` as the CRM.
* [ ] CRM: `LEAD_INGEST_SECRET` is set in `.env` on the VPS, `WEBSITE_SIGNATURE_REQUIRED` is empty or absent, and the app has been recreated since.
* [ ] System Health (Admin) row **Website request signing** shows the secret as present and strict mode **Off**, and `/api/health` (with the `CRON_SECRET` bearer)
      reports `readiness.websiteSignature: "optional"`.
* [ ] A real test enquiry from the live website arrived with a **visitor IP and location** in its "Lead Submission Information" (proof that signed requests are
      being verified, not just ignored). Do the same for the contact form and the newsletter box.
* [ ] No unexpected caller of `/api/public/lead-capture` in the logs (point 2 above).
* [ ] Both servers' clocks are synchronised.

## Switch on (on the VPS, in the deployment directory)

```bash
# 1. Edit .env: add or change this one line (leave LEAD_INGEST_SECRET as it is)
WEBSITE_SIGNATURE_REQUIRED=true

# 2. Recreate the app container. A plain `docker compose restart` does NOT re-read .env.
docker compose up -d app
```

compose.yaml forwards `WEBSITE_SIGNATURE_REQUIRED`, `LEAD_INGEST_SECRET` and `LEAD_INGEST_SECRET_PREVIOUS` to the app. (Before 2026-11-22 it did not, so this switch
could not have worked on the VPS; `src/__tests__/compose-env-propagation.test.ts` and a CI smoke step now guard that.)

## After

* `/api/health` (bearer) shows `readiness.websiteSignature: "required"`, and the System Health row says unsigned, replayed and modified requests are refused.
* Submit a real enquiry from the website: it must still arrive. Then, from a machine on the private network, confirm an unsigned request is refused:
  `401` with `{"ok":false,"error":"Invalid request signature."}` (public routes) or `invalid_signature` (flight route).
* Watch the app log for `[website-signature] refused: <reason>` (a fixed tag; it never contains the signature, the context, the nonce, the body or an IP). A steady stream
  of `expired` or `future` means clock drift; `missing` means a caller that does not sign; `replayed` should be rare and only ever caused by an attacker or a double-send of one signed request.

## Roll back

Set `WEBSITE_SIGNATURE_REQUIRED=` (empty) or remove the line, then `docker compose up -d app`. That returns to the transitional mode in seconds and loses no data.
To switch verification off entirely, remove `LEAD_INGEST_SECRET` as well (then no visitor IP or location is recorded).

## Rotating the secret

Put the new value in `LEAD_INGEST_SECRET` and the old one in `LEAD_INGEST_SECRET_PREVIOUS`, `docker compose up -d app`, deploy the new value to the website, then
remove `LEAD_INGEST_SECRET_PREVIOUS` and recreate again. Both values are compared in constant time and neither is logged.

## What was verified, and what was not

Verified by automated tests (run in CI): signed, unsigned, v1, tampered (method, path, company, body), expired, future-dated, replayed, wrong-secret, previous-secret
and malformed requests, in transitional and strict mode (`website-request-signature.test.ts`, and `lead-capture/__tests__/signature.test.ts` for the fourth route); the
one-time nonce against real PostgreSQL (`website-signature-replay.integration.test.ts`, run in CI); the variable reaching the container (compose test and a CI smoke step).
The website's own signer was also run against the CRM verifier by hand during this review (matching signatures and the shared known-answer vector); that was a one-off
check, not a committed test.

**Not verified here: a live end-to-end submission from the production website to the production CRM.** That needs the deployed website, and is the "Before" checklist above.
