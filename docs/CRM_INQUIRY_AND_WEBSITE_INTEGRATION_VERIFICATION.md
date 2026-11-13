# CRM Inquiry Lifecycle and Website Integration Verification

Date: 2026-11-13. Scope: the updated CRM only; the website projects were read, never modified. Nothing was submitted to a real endpoint; every check is a mocked-Prisma unit/route test with fake people and documentation addresses. Database-level behaviour (advisory locks, unique constraints, transactions) is **not** verified here because no PostgreSQL is available - it is covered by integration suites that are skipped without a disposable database.

## 1. The two inbound paths

| Path | Caller | Auth | Result row |
| --- | --- | --- | --- |
| Website flight request: `POST /api/v1/website/flight-inquiries` | the website's server (never the browser) | `Authorization: Bearer WEBSITE_API_KEY` (or `_NEXT` during rotation), `Idempotency-Key` header | a `Lead` (with its `LeadSubmissionInfo`) |
| Website contact form: `/api/public/contact-inquiry` | the website's server action | signed visitor-context headers (HMAC, `LEAD_INGEST_SECRET`) | a `ContactInquiry` (with `InquirySubmissionInfo`) |

The website holds no database access; it only calls these routes (verified by reading the website's `src/lib/crm-api/*`).

## 2. Verified behaviour (route-level tests, `route.test.ts`, 26 tests)

- **Compatibility**: the website's real payload shape (round trip, one way, multi-city with segments, passengers, flexible dates, budget + currency, notes, preferred airline, phone) is accepted unchanged and every field reaches the lead-creation call; unknown fields are rejected by the strict schema (no silent drop).
- **Validation**: malformed bodies, wrong types, missing required fields, bad phone, oversized bodies (32 KB cap) give `400 validation_failed` with field paths only (no echo of submitted values), and nothing is created.
- **Authentication**: missing/wrong/rotated key gives 401; failures are rate-limited and audited; the route answers 404 when Cloudflare headers (`cf-ray`, `cf-connecting-ip`, `cf-visitor`) show the request came through the public edge, unless `WEBSITE_API_ALLOW_PUBLIC_ROUTE=true` (the API is private-network only).
- **Company**: fixed by the credential, never by the caller.
- **Idempotency**: the `Idempotency-Key` becomes the lead's submission id; the request body is hashed (key order independent) into a stored fingerprint; the same key with the same body returns the original result as a duplicate (no second lead); the same key with a different body is rejected (409); a different key creates a new lead.
- **Visitor context**: a correctly signed context carries IPv4/IPv6 and approximate location into the stored submission info; forged, stale or wrongly signed contexts are ignored (the lead is still created, without IP).
- **Contact form**: id derived deterministically from company + source + submission key (`deriveInquiryId`), duplicate returns the same id with `duplicate: true`, same key with different content is a conflict; duplicate submissions do not write a second activity (`public-inquiry-idempotency.test.ts`, `inquiry-submission.test.ts`).

## 3. Lifecycle after creation

Lead creation records `LEAD_CREATED`-type activity; assignment/distribution, "New Flight Request" email and the accept-lead flow are unchanged from the original and covered by existing unit tests (`lead-capture`, `lead-queue`, `lead-intake` suites). Inquiry detail shows masked IP/location with Admin-only reveal (`inquiry-detail-*` component tests, `inquiry-submission.test.ts`).

## 4. Findings and limitations

1. **Privacy-policy mismatch (needs an owner decision):** the website's Privacy Policy mentions IP/location collection for flight requests only. The CRM also stores submission info for contact-form inquiries when the website sends a signed context. At present the website's contact form sends **no** visitor context (so nothing is stored for those), but the CRM side is ready to; the policy text should be aligned before that is turned on.
2. Contact-form location label is "Vercel edge geolocation" when it comes through the signed context (cosmetic).
3. `BFT-` ids are internal-only (not part of the public API contract).
4. Duplicate and conflict behaviour under real concurrency (two simultaneous identical requests) is protected by `pg_advisory_xact_lock(hashtextextended(...))` plus the fingerprint table; verified by reading and by mocks only. **Requires database verification** (`website-api.integration.test.ts`, `public-inquiry-idempotency.integration.test.ts`).
5. No real website-to-CRM round trip was run (no database, and the rule against real submissions).

## 5. Status

| Item | Status |
| --- | --- |
| Website payload accepted, mapped, validated | Verified working (mock-tested route) |
| Authentication, private-route refusal, rate limit, audit | Verified working (mock-tested) |
| Idempotency / duplicate / conflict logic | Mock-tested; **requires database verification** for concurrency |
| IP/location capture from signed context | Verified working (mock-tested) |
| Activity records, assignment, email | Mock-tested; email needs external-service verification |
| Website unchanged | Confirmed: nothing in this task touched the website projects |
