# Website lead API — `POST /api/v1/website/flight-inquiries`

The authenticated **server-to-server** way for the BusinessFlights.travel website's *backend* to create a flight-inquiry Lead in the CRM.
The website never receives database credentials and never touches the database: it makes one private-network HTTP call to the
CRM, which applies all of the CRM's own business rules.

> **Status.** Implemented and tested in this repository; **not deployed**. Nothing here has been run against production, and the one
> migration it needs (`20261016000100_lead_ingest_fingerprint`) has not been applied to any production database. The website
> repository is separate and is not changed by this work — the call it must make is described below.

## Why a separate endpoint

`/api/public/lead-capture` is the **browser-facing**, unauthenticated path (anyone on the internet can POST to it, the company comes from the
payload, protection is per-IP rate limiting). It stays exactly as it was. A trusted backend integration should not share it:

| | `/api/public/lead-capture` | `/api/v1/website/flight-inquiries` |
| --- | --- | --- |
| Caller | any browser / script | the website's backend only |
| Authentication | none | dedicated bearer key (constant-time check, rotation support) |
| Company | chosen by the payload | fixed by the credential (`WEBSITE_API_COMPANY_ID`) — the caller cannot choose a tenant |
| Idempotency | optional `submissionId` in the body | **required** `Idempotency-Key` header; reuse with a different request → `409` |
| Input | tolerant | strict: unknown fields are rejected, body ≤ 32 KB, JSON only |
| Rate limit | per connection IP | one shared budget for the authenticated caller + a separate budget for failed authentication |
| Network | public | private network only; a request that arrived through the public Cloudflare hostname gets `404` |
| Visitor IP / location | from the request's own trusted headers | **only** from a verified signed context — the connection is the website's server, never believed |

Both endpoints create leads through **one shared implementation** (`src/server/lead-intake.ts`): contact de-duplication, ownership of repeat
customers, status, multi-city legs, airport resolution, activity log and queue distribution are identical and cannot drift.

## Request

```
POST /api/v1/website/flight-inquiries
Authorization: Bearer <WEBSITE_API_KEY>
Idempotency-Key: <unique per submission, reused on every retry of it>
Content-Type: application/json
```

* `Idempotency-Key`: 8–200 characters from `A–Z a–z 0–9 . _ -`. Generate one **per form submission** (for example when the form mounts) and send the
  **same** value on every retry of that submission. A random UUID is ideal. It is the website's existing `submissionId`.
* Body: JSON object, at most **32 KB**. `Content-Type` must be `application/json` (a charset suffix is fine).

### Body fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `firstName` | string 1–200 | yes | |
| `lastName` | string 1–200 | yes | |
| `phone` | string 1–50 | yes | Must be a possible real number (the CRM's normal rule, including recovery of a number typed without `+`); otherwise `400` |
| `email` | string, valid address | no | |
| `tripType` | `ONE_WAY` \| `ROUND_TRIP` \| `MULTI_CITY` | no | default `ROUND_TRIP` |
| `departureAirportIata`, `arrivalAirportIata` | 3 letters | no | an unknown code is stored without an airport rather than failing the request |
| `departureDate`, `returnDate` | string (ISO date) | no | |
| `segments` | array of 1–`MAX_LEAD_SEGMENTS` (20) legs `{ departureAirportIata, arrivalAirportIata, departureDate? }` | no | multi-city itinerary; every leg is stored, in order, and the lead-level route mirrors the first leg |
| `cabinClass` | `ECONOMY` \| `PREMIUM_ECONOMY` \| `BUSINESS` \| `FIRST` | no | default `ECONOMY` |
| `adults` / `children` / `infants` | integer | no | `adults` 1–20 (default 1); `children`, `infants` 0–20 (default 0) |
| `datesFlexible` | boolean | no | |
| `preferredAirline` | string ≤ 200 | no | |
| `approximateBudget` | number > 0 | no | |
| `budgetCurrency` | ISO 4217 code | no | upper-cased; kept with the submission details |
| `additionalNotes` | string ≤ 5000 | no | |

**Unknown fields are rejected** (`400`), not ignored — including `companyId`, `submissionId` (use the header), `source`, `status`,
`assignedAgentId`, `priority`, `ipAddress`. The CRM sets source (`WEBSITE`), priority, status, assignment, company and timestamps itself.

### Example

```bash
curl -sS -X POST http://compass-crm:3000/api/v1/website/flight-inquiries \
  -H "Authorization: Bearer $WEBSITE_API_KEY" \
  -H "Idempotency-Key: 7f0c9b7e-5a52-4d0a-8c52-3d3a1d3f2b10" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Jane",
    "lastName": "Doe",
    "phone": "+14155552671",
    "email": "jane@example.com",
    "tripType": "ROUND_TRIP",
    "departureAirportIata": "FRA",
    "arrivalAirportIata": "MSP",
    "departureDate": "2026-12-01",
    "returnDate": "2026-12-15",
    "cabinClass": "BUSINESS",
    "adults": 2,
    "children": 1,
    "datesFlexible": true,
    "preferredAirline": "Lufthansa",
    "approximateBudget": 3200,
    "budgetCurrency": "EUR",
    "additionalNotes": "Window seats if possible"
  }'
```

## Responses

All responses are JSON with `Cache-Control: no-store`.

**Success**

| Status | Body | Meaning |
| --- | --- | --- |
| `201` | `{ "ok": true, "leadId": "c…", "duplicate": false }` | Lead created. `leadId` is stable and is the CRM's lead id. |
| `200` | `{ "ok": true, "leadId": "c…", "duplicate": true }` | This `Idempotency-Key` was already used for the **same** request: the existing lead is returned and **nothing else is written**. |

**Errors** — always `{ "ok": false, "error": { "code": "…", "message": "…", "fields"?: [{ "path": "…", "message": "…" }] } }`. Messages are written
for a developer, never contain an exception, stack trace, SQL, host name, secret or any submitted value.

| Status | `code` | Retry? | Meaning |
| --- | --- | --- | --- |
| `400` | `validation_failed` | **No** — fix the request | One or more fields are invalid; `fields` lists the paths and rules (at most 10) |
| `400` | `invalid_json` | No | Not valid JSON, or not a JSON object |
| `400` | `idempotency_key_required` | No | Missing or malformed `Idempotency-Key` |
| `401` | `unauthorized` | No | Missing or wrong credential (`WWW-Authenticate: Bearer`) |
| `404` | `not_found` | No | The request came through the public hostname (see *Network*) |
| `409` | `idempotency_key_reused` | No | This key was already used for a different request, or the original request cannot be verified. Use a new key for a new submission |
| `413` | `payload_too_large` | No | Body over 32 KB |
| `415` | `unsupported_media_type` | No | Not `application/json` |
| `429` | `rate_limited` | **Yes**, after `Retry-After` seconds, same key | Too many requests, or too many failed authentications |
| `500` | `internal_error` | **Yes**, same key | The request could not be saved (including any unanticipated server error — it is still this JSON shape). Nothing is half-saved under the key |
| `503` | `not_configured` | **Yes**, later | The API is not enabled on this server (no/short key, or the configured company is missing) |

## Idempotency, retries and timeouts

* The lead id is **derived from the `Idempotency-Key`** with the same derivation the public endpoint and the website's former direct write use. A key therefore
  maps to exactly one lead, enforced by the database primary key — not by a check-then-insert. Concurrent retries race on the primary key; the loser
  is answered as a repeat (`200`).
* The CRM stores a SHA-256 fingerprint of the canonical request (sorted keys, defaults applied, strings trimmed) **in the same insert as the lead**
  (`LeadIngestFingerprint`). Retrying the same request — in any key order or spacing — is a repeat; a different request under the same key is `409`.
* A lead created by another route (such as the public endpoint or a direct write) may have no fingerprint. In that case, the API cannot verify that the original payload matches and returns `409 idempotency_key_reused` rather than claiming a verified duplicate. The existing lead is not recreated.
* A key that resolves to a lead of another company is never answered with that lead (`409`).
* **A `201` is only sent after the lead (contact, status history, itinerary, submission details, fingerprint) is committed.** If the response is lost, the
  retry returns the same lead.
* **Recommended client behaviour:** timeout 10 s per attempt; on a network error, timeout, `429`, `500` or `503` retry the **same request with the
  same `Idempotency-Key`**, backing off (1 s, 2 s, 4 s … up to ~5 attempts, honouring `Retry-After`). Never retry `4xx` other than `429`. If all attempts
  fail, show the visitor a friendly error and keep the submission to resend later with the same key — never generate a new key for the same submission.
* Retrying is always safe: it cannot create a second lead, contact, activity or queue entry.

## Authentication

* A dedicated bearer key, **`WEBSITE_API_KEY`**, held only in server-side environment variables on the CRM and on the website's backend. It is never a
  `NEXT_PUBLIC_*` variable, never in browser JavaScript, a response, a log line or Git. It is separate from `CRON_SECRET` and `LEAD_INGEST_SECRET`; none
  of those is accepted in its place.
* At least **32 characters** (a shorter value counts as "not configured" and the API answers `503`). Generate with `openssl rand -hex 32`.
* The key is compared in constant time (SHA-256 digests, every configured key, no early exit). Failed attempts are counted globally (30 per 15 minutes,
  then `429`); the counter only counts *failures*, so an attacker cannot use up the legitimate caller's budget.
* The authenticated caller has its own ceiling: **120 requests per minute** (shared by the website's backend), then `429` with `Retry-After`.

### Rotating the key without downtime

1. Generate a new key. Set `WEBSITE_API_KEY_NEXT=<new>` in the CRM's environment and restart the CRM application so it reloads it. Both keys now work.
2. Switch the website's backend to the new key and restart it.
3. In the CRM's environment, move the new value into `WEBSITE_API_KEY` and remove `WEBSITE_API_KEY_NEXT`; restart the CRM application. The old key stops working.

If a key may have leaked, do steps 1–3 immediately; the old key is refused as soon as step 3 is applied.

## Network (private network)

This API is meant for a **private** path between the website's backend and the CRM, not for the internet. This repository does not define that network:
how the two servers reach each other (for example a private container network, where the CRM could answer as `http://compass-crm:3000`) is a deployment
decision. Whatever it is, the website's backend needs only the CRM's URL and the bearer key — **never** the CRM's database URL — and nothing should be
published on the CRM's host for this purpose.

**Public hostname.** If the CRM is also reachable from the internet through a Cloudflare tunnel, every request through the tunnel carries `CF-Ray`, and this API answers
those with `404`. That check is **supplemental only — it is not authentication and not the isolation**: the isolation is the private network, and the authentication is the
bearer key. The check only makes sure the endpoint is not answered on the public hostname; because Cloudflare adds those headers to every tunnel request and a caller on the
internet cannot remove them, it holds, but do not rely on it alone: for defence in depth also add a Cloudflare rule that blocks `/api/v1/website/*` on the public hostname.
Only if the website must call the CRM over its public `https://` URL (for example it runs on another provider) set `WEBSITE_API_ALLOW_PUBLIC_ROUTE=true` — then the bearer
key and the rate limits are the only barrier; prefer the private network.

## Visitor IP and approximate location (optional)

Because the call comes from the website's server, the connection's addresses describe **that server, not the visitor**, and are never recorded. To record the
visitor's IP and approximate location, forward what the website's edge observed in the existing **signed visitor context** (HMAC with `LEAD_INGEST_SECRET`,
≥ 32 characters, identical on both sides):

```
x-ct-visitor-context:   base64url( JSON { v: 1, ts: <unix seconds>, ip?, city?, region?, country?, timezone? } )
x-ct-visitor-signature: hex( HMAC-SHA256( LEAD_INGEST_SECRET, <the context header value exactly as sent> ) )
```

Without a valid context the lead is created with **no IP and no location** (never the connection's). A context that fails verification (wrong secret, bad
signature, older than 5 minutes, malformed, private/reserved IP) is ignored the same way. The IP and location are shown only in the lead's permission-gated
"Lead Submission Information" section; see `docs/DEPLOYMENT.md` §5.2.

## What the CRM does with a request

1. Refuses a request that arrived through the public edge; authenticates; applies the rate limits; checks headers and size; reads the body with a hard cap;
   validates strictly.
2. Looks up the configured company (`WEBSITE_API_COMPANY_ID`, default `default-company`).
3. Resolves airports by IATA code, finds or creates the contact (same de-duplication as an agent-entered lead; a repeat customer's lead goes to that
   contact's owner), and creates in **one insert**: the lead (`source = WEBSITE`, `priority = MEDIUM`, status per ownership), its status history, every
   multi-city leg, the submission details, the idempotency fingerprint **and the `LEAD_CREATED` activity** — all or nothing, so a failed attempt leaves no lead
   without its creation activity (or the reverse). Only a unique-key collision on the lead's own id counts as "already received" (`200`); any other failure
   is a `500` that is safe to retry with the same key.
4. For an unowned lead, starts the normal acceptance queue (a failure there never loses the lead; the existing
   sweep picks it up).
5. Writes an **append-only audit row** (`WEBSITE_API_LEAD_CREATED`, `_DUPLICATE` or `_CONFLICT`; entity `Lead`) holding only the lead id, the company and the
   channel `website-api` — never the request, the customer's details, the key or the Idempotency-Key.

Logging: only fixed, data-free tags are ever logged (`[website-api] lead creation failed`, …). No request body, personal data, key or Idempotency-Key is logged.

## Integration contract for the website team (server side only)

Everything here runs in the **website's backend** (for example a Next.js Server Action or Route Handler). Nothing here may run in the browser.

**Endpoint:** `POST <CRM_API_URL>/api/v1/website/flight-inquiries` (for example `http://compass-crm:3000` on a private network; plain HTTP is fine inside a private network).
**Authentication:** header `Authorization: Bearer <key>`. **Idempotency:** header `Idempotency-Key: <per-submission key>`. **Body:** JSON, fields as in the table above.

**Configuration on the website server** (names are the website's own choice; these are suggestions):

| Variable | Value | Rules |
| --- | --- | --- |
| `CRM_API_URL` | `http://compass-crm:3000` | server-side only |
| `CRM_API_KEY` | the key the CRM operator generated (`openssl rand -hex 32` on the CRM side) | **never** a `NEXT_PUBLIC_*` variable, never imported by client code, never in the repository, a log line, an error message, an analytics event or a response to the browser. Keep it in the website server's `.env` (mode 600) or a secret store |

Do not forward the visitor's own request headers to the CRM (especially anything starting with `cf-`): the CRM refuses calls that look as if they came through the public hostname.

**Per submission:**

1. When the form is rendered (or on first submit) generate one random key, e.g. `crypto.randomUUID()`, and keep it with the submission. It is the `Idempotency-Key` for **every** attempt of that submission and is never reused for a different one.
2. Build the JSON body from the validated form fields only. Never include `companyId`, `submissionId`, `source`, `status`, an IP address or anything else not in the field table (unknown fields are rejected with `400`).
3. Send with a **10 second timeout**. Handle the result:

| Result | What the website does |
| --- | --- |
| `201` or `200` (`ok: true`) | Success. Store/show `leadId`. `duplicate: true` means this submission was already received — treat exactly like success, do not send a second notification email |
| network error, timeout, `429`, `500`, `503` | Retry the **same body with the same key**: wait 1 s, 2 s, 4 s, 8 s (honour `Retry-After` on `429`), at most 5 attempts. If all fail, show the visitor a friendly error and keep the submission to resend later — **do not** create a new key |
| `400` | A bug or a validation mismatch: do not retry. Log the `error.fields` **paths** (not values) and show the visitor a generic error |
| `401`, `404` | Configuration problem (wrong or rotated key; calling through the public hostname). Do not retry; alert the operator. Never log the key |
| `409` | The same key was already used for a different request — a bug in key handling. Do not retry with the same key |
| `413`, `415` | A bug (body over 32 KB, or not JSON). Do not retry |

**Sketch (TypeScript, server only; fake data):**

```ts
// server-side module of the website — never imported from a client component
export async function sendInquiry(inquiry: Inquiry, idempotencyKey: string) {
  const delays = [0, 1000, 2000, 4000, 8000];
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(`${process.env.CRM_API_URL}/api/v1/website/flight-inquiries`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.CRM_API_KEY}`, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(inquiry), // { firstName: "Jane", lastName: "Doe", phone: "+14155552671", ... }
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 200 || res.status === 201) return (await res.json()) as { ok: true; leadId: string; duplicate: boolean };
      if (![429, 500, 503].includes(res.status)) throw new Error(`CRM refused the inquiry (HTTP ${res.status})`); // no retry; never log the body or the key
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("CRM refused")) throw err;
      // network error or timeout: loop and retry with the SAME key
    }
  }
  throw new Error("CRM unavailable after retries; keep the submission and resend later with the same key");
}
```

**Testing without touching production:**

1. Run a separate CRM instance (on a developer machine or a staging server) with its **own** throwaway database, environment, and a throwaway `WEBSITE_API_KEY` (`openssl rand -hex 32`). Never reuse the production key or database.
2. Point the website's `CRM_API_URL` / `CRM_API_KEY` at that instance.
3. Check, in this order: no key → `401`; wrong key → `401`; right key but no `Idempotency-Key` → `400`; a valid inquiry → `201` and the lead appears in that instance's CRM; the **same** request again → `200` with `duplicate: true` and still one lead; the same key with a changed field → `409`; kill the connection mid-request and retry with the same key → one lead.
4. Confirm the website's logs and browser network panel contain no key and no customer data from failed calls.

## Configuration (server-side environment variables)

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `WEBSITE_API_KEY` | CRM `.env` (and the website's backend `.env`, under any name) | unset = API disabled (`503`) | the bearer key, ≥ 32 characters |
| `WEBSITE_API_KEY_NEXT` | CRM `.env` | unset | second accepted key, for rotation |
| `WEBSITE_API_COMPANY_ID` | CRM `.env` | `default-company` | the tenant API leads belong to |
| `WEBSITE_API_ALLOW_PUBLIC_ROUTE` | CRM `.env` | unset (refuse tunnel traffic) | `true` to accept calls that arrived via the public hostname |
| `LEAD_INGEST_SECRET` | both | unset | optional: signs the visitor context |

The values live only in the CRM server's environment (never in Git, an image, a log or a browser-visible variable), and are read by the CRM application only.

## Deploying

This change adds **one additive migration** (`20261016000100_lead_ingest_fingerprint`: a new table and its foreign key; nothing existing is touched). It has **not**
been applied to any production database. When the code is approved and merged, follow your normal controlled deployment:

1. Take a verified database backup first.
2. Apply the migration with your usual forward-only step (`prisma migrate deploy` — it never resets or drops anything) **before** starting the new code: older code ignores
   the extra table, but the new endpoint needs it.
3. Add `WEBSITE_API_KEY` (generate with `openssl rand -hex 32`) and `WEBSITE_API_COMPANY_ID` to the CRM's environment (and `LEAD_INGEST_SECRET` if you forward the visitor
   context), then restart the CRM application.
4. Smoke-test from the private network: a call with a wrong key must return `401`, and one without a key `401`; with the API key unset the endpoint returns `503`.

Rollback: redeploy the previous application version. The new table is unused by older code and can stay.

## Tests

* `src/server/actions/__integration__/website-api.integration.test.ts` — real PostgreSQL: authentication (missing / wrong / malformed / rotation / other secrets),
  the private-network rule, rate limits, strict validation and size limits, company fixed by the credential, creation with every default, idempotency
  (sequential, concurrent, different-content, mixed with the public endpoint, cross-company), visitor-context handling, audit rows, failure handling that
  leaks nothing and loses nothing.
* `src/server/security/__tests__/website-api-auth.test.ts` — the credential logic.
* `src/__tests__/website-api-guards.test.ts` — the key is read in one module, never reaches a client, the route's order of checks, the documented variables.
* The existing `/api/public/lead-capture` tests (unit + real database) still pass unchanged against the shared core.
