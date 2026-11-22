# CRM <-> website API contract verification (signing v2, per-visitor limiting)

Date: 2026-11-22. CRM release branch `release/compass-tools-2026-11-22`. Evidence is source code and unit tests of BOTH applications, read-only on the website side
(`Travel Agency Website-updated`, which was not modified). Nothing was deployed, no production system or credential was touched, no real request was sent.

## Endpoints and who signs what

| Endpoint | Authentication | v2 signature | Idempotency | Company that is signed |
| --- | --- | --- | --- | --- |
| `POST /api/v1/website/flight-inquiries` | `Authorization: Bearer <WEBSITE_API_KEY>` | yes | `Idempotency-Key` (required, unchanged across retries) | the credential's company (`WEBSITE_API_COMPANY_ID` or the key's company) |
| `POST /api/public/contact-inquiry` | none (public) | yes (website only; the CRM's own inquiry page is unaffected) | `submissionId` | the body's `companyId` |
| `POST /api/public/subscribe` | none (public) | yes | none (duplicate address is a no-op) | the body's `companyId` |
| `POST /api/public/lead-capture` | none | v1 context unchanged (it has other callers) | - | - |

## Compared field by field (website source vs CRM source)

| Item | Website (`src/lib/crm-api/visitor-context.ts`) | CRM (`src/server/website-request-signature.ts`) | Same? |
| --- | --- | --- | --- |
| Headers | `x-ct-visitor-context`, `x-ct-visitor-signature` | the same two names | yes |
| Envelope | base64url JSON `{ v: 2, ts, nonce, ip?, city?, region?, country?, timezone?, source? }` | same shape, same allow-lists | yes |
| Canonical message | `"CT-WEBSITE-REQUEST-V2"` LF, then `<UTF-8 byte length>:<field>` joined by LF: METHOD, path, companyId, ts, nonce, SHA-256(body bytes), context header as sent | identical field order, domain tag and length prefixes | yes |
| MAC | HMAC-SHA-256 with `LEAD_INGEST_SECRET`, hex | same; constant-time comparison; rotation via `LEAD_INGEST_SECRET_PREVIOUS` | yes |
| Body binding | exact serialised bytes that are sent | exact bytes received (never a re-serialisation) | yes |
| Timestamp | unix seconds, fresh per attempt | at most 120 s old, at most 30 s ahead | compatible |
| Nonce | 16 random bytes, base64url (22 chars), fresh per attempt | `[A-Za-z0-9_-]{22,64}`, consumed once per company in a shared database table | compatible |
| Retries | a retry is signed again; the `Idempotency-Key` / `submissionId` stays | a retry is a new request (new nonce), collapsed into a duplicate by the idempotency record | yes |
| Known-answer vector | `tests/contact-visitor-context.spec.ts` | `src/server/__tests__/website-request-signature.test.ts` | the same signature (`5bafec28...ed6d6`) in both, independently implemented |
| Error format | - | flight route: `{ error: { code: "invalid_signature" \| "rate_limited" \| "unavailable", ... } }` with 401 / 429 + `Retry-After` / 503; public routes: `{ ok: false, error }` | fixed texts, nothing reflected |

## Rollout (CRM first, website second) and the switch

Strict mode needs `LEAD_INGEST_SECRET` AND `WEBSITE_SIGNATURE_REQUIRED=true`. Deployed without the switch the CRM verifies a valid v2 signature (single-use, per-visitor limit) but
still accepts the website that is live today, so the required deployment order cannot break lead capture. Set the switch after the updated website is live. A design finding of
this review: the earlier uncommitted version made strict mode implicit in the secret, which would have refused the live website between the two deployments. See
`docs/WEBSITE_LEAD_API.md` for the procedure.

## Rate limits (proposed defaults, pending your approval)

* Account-wide (flight route, unchanged): 120 requests per minute for the whole website credential.
* Per visitor (new): 20 requests per 15 minutes per verified visitor IP, in a website-only bucket per endpoint (`WEBSITE_FLIGHT:website`, `CONTACT_INQUIRY:website`, `SUBSCRIBE:website`). The IP is inside the signed envelope, so a visitor cannot choose it or reset it by varying other fields. Traffic the website could not attribute shares one bucket with five times that allowance. These numbers are the existing lead-capture allowance reused, not a new product decision.
* Both counters are the existing atomic `INSERT ... ON CONFLICT DO UPDATE` on `RateLimitCounter` (shared across instances and restarts). A refused signature never counts against a visitor.

## Environment variables (names only)

CRM: `WEBSITE_API_KEY`, `WEBSITE_API_COMPANY_ID`, `LEAD_INGEST_SECRET`, `WEBSITE_SIGNATURE_REQUIRED`, `LEAD_INGEST_SECRET_PREVIOUS` (during a rotation only), `TRUSTED_PROXY`.
Website: `CRM_API_KEY` (= `WEBSITE_API_KEY`), `LEAD_INGEST_SECRET` (identical value), the CRM base URL and company id as configured there.

## Verified and not verified

* Verified by unit tests (CRM: 53 tests for the verifier, guard, rotation and limiting, plus the route suites (52 for the flight route, the public-route signing suite for contact and subscribe); website: its own contract tests): method/path/company/body/context tampering, wrong secret, previous secret, expired and future timestamps, malformed and missing nonce, v1/v3 versions, replay (sequential and concurrent), store outage (503), retries, per-visitor and unattributed buckets, independence of visitors, no counting of forged requests, transitional and strict mode, log lines without secrets.
* Not verified: the nonce INSERT and the limiter against a real PostgreSQL (BLOCKED here, run by the CI database job); the live website against a live CRM; clock skew between the real servers (120 s / 30 s windows are generous but unmeasured).
