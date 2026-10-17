import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkAccountRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { arrivedViaPublicEdge, authenticateWebsiteApi, publicRouteAllowed, websiteApiCompanyId } from "@/server/security/website-api-auth";
import { buildLeadSubmissionInfoCreate } from "@/server/lead-submission-info";
import { createWebsiteFlightLead, flightInquiryBase, refinePhone } from "@/server/lead-intake";
import { auditWebsiteApi } from "@/server/website-api-audit";

// POST /api/v1/website/flight-inquiries  —  the authenticated SERVER-TO-SERVER way for the BusinessFlights.travel website's backend to
// create a flight-inquiry Lead. Full contract: docs/WEBSITE_LEAD_API.md. Deliberately separate from /api/public/lead-capture (the
// browser-facing, unauthenticated path): different credential, company fixed by the credential, mandatory idempotency, strict input.
//
// Order of checks (cheapest and least revealing first):
//   1. arrived through the public Cloudflare hostname?      -> 404 (this API is for the private Docker network)
//   2. a key is configured / the presented key is right     -> 503 / 401 (failures are counted globally, then 429)
//   3. the caller's request budget                          -> 429
//   4. Content-Type, declared size, Idempotency-Key         -> 415 / 413 / 400
//   5. body (size-capped while reading), JSON, strict schema-> 413 / 400
//   6. the configured company exists                        -> 503
//   7. create (or recognise a repeat) in ONE insert         -> 201 / 200 / 409 / 500
//
// Nothing here ever echoes the key, the request body, a stack trace or a database message. Personal data is never logged.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The largest accepted body. A real request is well under 2 KB; the biggest legal one (20 legs + 5000-character notes) is ~12 KB. */
const MAX_BODY_BYTES = 32 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,200}$/;
const SOURCE_LABEL = "website-api";

const NO_STORE = { "Cache-Control": "no-store" };

type ErrorCode =
  | "not_found"
  | "not_configured"
  | "unauthorized"
  | "rate_limited"
  | "unsupported_media_type"
  | "payload_too_large"
  | "idempotency_key_required"
  | "invalid_json"
  | "validation_failed"
  | "idempotency_key_reused"
  | "internal_error";

function fail(status: number, code: ErrorCode, message: string, extra: { fields?: { path: string; message: string }[]; headers?: Record<string, string> } = {}) {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(extra.fields ? { fields: extra.fields } : {}) } },
    { status, headers: { ...NO_STORE, ...(extra.headers ?? {}) } }
  );
}

/** Reads the body but never more than `max` bytes, so an oversized or endless request cannot be buffered into memory. */
async function readLimited(req: Request, max: number): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") };
}

/** Canonical JSON (sorted keys) so two requests with the same content hash the same whatever the sender's key order or spacing. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const apiSchema = flightInquiryBase
  // The idempotency key travels in the Idempotency-Key header only; a body "submissionId" (or "companyId", or anything else unknown) is an
  // error, not silently ignored - the caller should learn about a mistake instead of believing it took effect.
  .omit({ submissionId: true })
  .strict()
  .superRefine(refinePhone);

/**
 * Safety net only. Every expected outcome below already returns its own documented status; this catches what nothing anticipated (for
 * example the database failing while the rate limit is checked) so the caller still gets the API's JSON error contract - a generic,
 * retryable 500 - and never Next's default error page or an exception message. It never reports success, and it logs a fixed tag only.
 */
export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch {
    console.error("[website-api] unexpected error");
    return fail(500, "internal_error", "The request could not be saved. Retry with the same Idempotency-Key.");
  }
}

async function handle(req: Request) {
  // 1. Private network only (see website-api-auth.ts). A plain 404: do not advertise that this API exists on the public hostname.
  if (arrivedViaPublicEdge(req.headers) && !publicRouteAllowed()) return fail(404, "not_found", "Not found.");

  // 2. Authentication.
  const auth = authenticateWebsiteApi(req.headers);
  if (auth === "not_configured") return fail(503, "not_configured", "This API is not enabled on this server.");
  if (auth === "unauthorized") {
    const failures = await checkAccountRateLimit("website-api", "auth-failure", RATE_LIMITS.WEBSITE_API_AUTH_FAILURES).catch(() => ({ allowed: true as const }));
    if (!failures.allowed) return fail(429, "rate_limited", "Too many failed attempts. Try again later.", { headers: { "Retry-After": String(failures.retryAfterSeconds) } });
    return fail(401, "unauthorized", "Missing or invalid credentials.", { headers: { "WWW-Authenticate": "Bearer" } });
  }

  // 3. The authenticated caller's own budget.
  const budget = await checkAccountRateLimit("website-api", "lead-create", RATE_LIMITS.WEBSITE_API_REQUESTS);
  if (!budget.allowed) return fail(429, "rate_limited", "Too many requests. Retry after the indicated delay with the same Idempotency-Key.", { headers: { "Retry-After": String(budget.retryAfterSeconds) } });

  // 4. Cheap header checks before the body is read.
  if (!/^application\/json(\s*;.*)?$/i.test(req.headers.get("content-type") ?? "")) return fail(415, "unsupported_media_type", "Content-Type must be application/json.");
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return fail(413, "payload_too_large", `The body must be at most ${MAX_BODY_BYTES} bytes.`);
  const idempotencyKey = (req.headers.get("idempotency-key") ?? "").trim();
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return fail(400, "idempotency_key_required", "Send an Idempotency-Key header of 8-200 characters (letters, digits, '.', '_', '-'), unique per submission and reused on every retry of it.");
  }

  // 5. Body, JSON, schema.
  const raw = await readLimited(req, MAX_BODY_BYTES);
  if (!raw.ok) return fail(413, "payload_too_large", `The body must be at most ${MAX_BODY_BYTES} bytes.`);
  let json: unknown;
  try {
    json = JSON.parse(raw.text);
  } catch {
    return fail(400, "invalid_json", "The body is not valid JSON.");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return fail(400, "invalid_json", "The body must be a JSON object.");
  const parsed = apiSchema.safeParse(json);
  if (!parsed.success) {
    // Field paths and rule messages only - never the submitted values.
    const fields = parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join(".") || "(body)", message: i.message }));
    return fail(400, "validation_failed", "The request did not pass validation.", { fields });
  }
  const data = parsed.data;

  // 6. The credential fixes the tenant. A missing company is a server misconfiguration, not the caller's mistake.
  const companyId = websiteApiCompanyId();
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }).catch(() => null);
  if (!company) {
    console.error("[website-api] the configured company does not exist");
    return fail(503, "not_configured", "This API is not enabled on this server.");
  }

  // 7. Create, or recognise a repeat. The Lead id derives from the Idempotency-Key with the SAME derivation the public endpoint and the
  // website's direct write use, so a submission can never become two leads by arriving through two routes; concurrent retries lose on
  // the primary key and are answered as repeats.
  const requestHash = createHash("sha256").update(canonical(data)).digest("hex");
  const submissionInfo = buildLeadSubmissionInfoCreate(req.headers, new Date(), {
    budgetCurrency: data.approximateBudget !== undefined ? data.budgetCurrency : undefined,
    serverToServer: true,
  });

  const result = await createWebsiteFlightLead({
    data: { ...data, submissionId: idempotencyKey },
    companyId,
    submissionInfo,
    idempotency: { requestHash, source: SOURCE_LABEL },
  });

  if (result.status === "failed") {
    console.error("[website-api] lead creation failed");
    return fail(500, "internal_error", "The request could not be saved. Retry with the same Idempotency-Key.");
  }

  if (result.status === "created") {
    await auditWebsiteApi({ action: "WEBSITE_API_LEAD_CREATED", leadId: result.id, companyId });
    return NextResponse.json({ ok: true, leadId: result.id, duplicate: false }, { status: 201, headers: NO_STORE });
  }

  // A repeat of this key. It is only a clean repeat when it is the same request, in the same company.
  const existing = await prisma.lead
    .findUnique({ where: { id: result.id }, select: { contact: { select: { companyId: true } }, ingestFingerprint: { select: { requestHash: true } } } })
    .catch(() => null);
  const sameCompany = existing?.contact.companyId === companyId;
  // A lead that has no fingerprint was created by another route (the public endpoint, the website's direct write): nothing to compare
  // against, so it is the same submission by definition of the shared key.
  const sameRequest = !existing?.ingestFingerprint || existing.ingestFingerprint.requestHash === requestHash;
  if (!existing || !sameCompany || !sameRequest) {
    await auditWebsiteApi({ action: "WEBSITE_API_LEAD_CONFLICT", leadId: result.id, companyId });
    return fail(409, "idempotency_key_reused", "This Idempotency-Key was already used for a different request. Use a new key for a new submission.");
  }
  await auditWebsiteApi({ action: "WEBSITE_API_LEAD_DUPLICATE", leadId: result.id, companyId });
  return NextResponse.json({ ok: true, leadId: result.id, duplicate: true }, { status: 200, headers: NO_STORE });
}
