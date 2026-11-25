// Signing v2: one authenticated, one-time envelope per website-to-CRM request.
//
// The v1 context (lead-ingest-context.ts) only vouched for the visitor fields; it did not bind the HTTP method, the path, the company or the body,
// and it had no nonce, so a captured envelope could be attached to a different request for the whole skew window. v2 binds all of them:
//
//   headers (the same two names as v1):
//     x-ct-visitor-context:   base64url( JSON { v: 2, ts, nonce, ip?, city?, region?, country?, timezone?, source? } )
//     x-ct-visitor-signature: hex( HMAC-SHA256( LEAD_INGEST_SECRET, canonicalMessage ) )
//
//   canonicalMessage = "CT-WEBSITE-REQUEST-V2" LF field LF field ...   where every field is written as  <byte length of its UTF-8 form>:<field>
//   fields, in this order:  METHOD (upper case) | path (pathname only, no query) | companyId | ts (decimal unix seconds) | nonce |
//                           SHA-256 of the EXACT request body bytes (64 lower-case hex) | the context header value exactly as sent
//
// Length prefixes make the encoding unambiguous (no delimiter can be smuggled inside a field). The method, path, company and body hash are NOT sent:
// the verifier recomputes them from the request it actually received, so changing any of them breaks the signature.
//
// Replay: the nonce is consumed once per company in a durable, shared store (the existing RateLimitCounter table: unique `key`, `expiresAt`, expired rows
// purged by the cron route). One INSERT ... ON CONFLICT DO NOTHING decides the race, so two concurrent submissions of the same envelope cannot both win,
// across instances and restarts. A legitimate retry is a NEW request: the website signs every attempt with a fresh nonce and timestamp, and the
// Idempotency-Key / submissionId (unchanged across attempts) is what turns the retry into a duplicate instead of a second record.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { websiteSignatureRequired } from "@/server/website-signing-policy";
import { VISITOR_CONTEXT_HEADER, VISITOR_SIGNATURE_HEADER, visitorFromContextPayload } from "@/server/lead-ingest-context";
import type { ApproximateLocation } from "@/lib/request-geo";

export const WEBSITE_SIGNATURE_VERSION = 2;
/** How old a signed request may be. Short on purpose: a legitimate request is signed immediately before it is sent. */
export const WEBSITE_SIGNATURE_MAX_AGE_SECONDS = 120;
/** How far ahead of this server's clock a timestamp may be (clock skew between the two servers). */
export const WEBSITE_SIGNATURE_MAX_FUTURE_SECONDS = 30;
const NONCE_RETENTION_EXTRA_SECONDS = 60;
const DOMAIN = "CT-WEBSITE-REQUEST-V2";
const MAX_CONTEXT_BYTES = 2048;
const MIN_SECRET_LENGTH = 32;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

export type SignedRequestParts = {
  method: string;
  /** Pathname only (no scheme, host or query). */
  path: string;
  companyId: string;
  ts: number;
  nonce: string;
  bodySha256: string;
  /** The context header value exactly as sent. */
  context: string;
};

/** The one canonical message both applications HMAC. Length-prefixed, so no field value can change where another one begins. */
export function canonicalWebsiteRequestMessage(p: SignedRequestParts): string {
  const fields = [p.method.toUpperCase(), p.path, p.companyId, String(p.ts), p.nonce, p.bodySha256, p.context];
  return `${DOMAIN}\n${fields.map((f) => `${Buffer.byteLength(f, "utf8")}:${f}`).join("\n")}`;
}

export function sha256Hex(body: Uint8Array | string): string {
  return createHash("sha256").update(typeof body === "string" ? Buffer.from(body, "utf8") : body).digest("hex");
}

export type WebsiteContextPayload = {
  v: 2;
  ts: number;
  nonce: string;
  ip?: string;
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
  source?: string;
};

/** Signs a request (used by the tests and by any first-party caller; the website has its own implementation of the same specification). */
export function signWebsiteRequestV2(input: { secret: string; method: string; path: string; companyId: string; body: Uint8Array | string; payload: WebsiteContextPayload }): {
  context: string;
  signature: string;
} {
  const context = Buffer.from(JSON.stringify(input.payload), "utf8").toString("base64url");
  const message = canonicalWebsiteRequestMessage({
    method: input.method,
    path: input.path,
    companyId: input.companyId,
    ts: input.payload.ts,
    nonce: input.payload.nonce,
    bodySha256: sha256Hex(input.body),
    context,
  });
  return { context, signature: createHmac("sha256", input.secret).update(message).digest("hex") };
}

export type WebsiteSignatureFailure = "no_secret" | "malformed" | "unsupported_version" | "bad_nonce" | "bad_signature" | "expired" | "future" | "replay";
export type VerifiedVisitor = { ip?: string; location?: ApproximateLocation; locationSource?: string };
export type WebsiteSignatureResult =
  | { state: "absent" }
  | { state: "invalid"; reason: WebsiteSignatureFailure }
  /** The one-time store could not be reached: the request is refused (fail closed), the caller may retry with a fresh signature. */
  | { state: "unavailable" }
  | { state: "verified"; visitor: VerifiedVisitor };

/** Returns true when the nonce was fresh (and is now consumed), false when it had already been consumed. Throws when the store is unreachable. */
export type NonceConsumer = (key: string, expiresAt: Date) => Promise<boolean>;

/** Durable, shared, atomic: the unique `key` decides the race between concurrent requests (and between instances). */
export const consumeNonceInDatabase: NonceConsumer = async (key, expiresAt) => {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "RateLimitCounter" ("id", "key", "count", "expiresAt", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${key}, 1, ${expiresAt}, now(), now())
    ON CONFLICT ("key") DO NOTHING
    RETURNING "id"
  `;
  return rows.length === 1;
};

export async function verifyWebsiteRequestSignature(input: {
  headers: Headers;
  method: string;
  /** Pathname of the request this server received. */
  path: string;
  /** The company the request is for (the credential's company, or the body's `companyId` on the public routes). */
  companyId: string | undefined;
  /** The exact body bytes that were received. */
  body: Uint8Array | string;
  nowMs?: number;
  secret?: string | undefined;
  /** The secret being rotated out (defaults to LEAD_INGEST_SECRET_PREVIOUS). */
  previousSecret?: string | undefined;
  consumeNonce?: NonceConsumer;
}): Promise<WebsiteSignatureResult> {
  const { headers } = input;
  const context = headers.get(VISITOR_CONTEXT_HEADER);
  const signature = headers.get(VISITOR_SIGNATURE_HEADER);
  if (!context && !signature) return { state: "absent" };

  const secret = "secret" in input ? input.secret : process.env.LEAD_INGEST_SECRET;
  // Key rotation: while the website is moved to a new secret, the CRM accepts the old one as well (LEAD_INGEST_SECRET_PREVIOUS). Remove it when the
  // rotation is finished. A previous secret that is too short is ignored, never used.
  const previousSecret = "previousSecret" in input ? input.previousSecret : process.env.LEAD_INGEST_SECRET_PREVIOUS;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return { state: "invalid", reason: "no_secret" };
  if (!context || !signature || context.length > MAX_CONTEXT_BYTES || !/^[0-9a-f]{64}$/i.test(signature)) return { state: "invalid", reason: "malformed" };

  let payload: Partial<WebsiteContextPayload>;
  try {
    payload = JSON.parse(Buffer.from(context, "base64url").toString("utf8"));
  } catch {
    return { state: "invalid", reason: "malformed" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { state: "invalid", reason: "malformed" };
  // v1 (and anything else) is refused on these routes: there is no downgrade path.
  if (payload.v !== WEBSITE_SIGNATURE_VERSION) return { state: "invalid", reason: "unsupported_version" };
  if (typeof payload.ts !== "number" || !Number.isInteger(payload.ts)) return { state: "invalid", reason: "malformed" };
  if (typeof payload.nonce !== "string" || !NONCE_PATTERN.test(payload.nonce)) return { state: "invalid", reason: "bad_nonce" };

  const message = canonicalWebsiteRequestMessage({
    method: input.method,
    path: input.path,
    companyId: input.companyId ?? "",
    ts: payload.ts,
    nonce: payload.nonce,
    bodySha256: sha256Hex(input.body),
    context,
  });
  const given = Buffer.from(signature, "hex");
  // Every candidate secret is always evaluated (no early exit), each comparison is constant-time.
  let matched = false;
  for (const candidate of [secret, ...(previousSecret && previousSecret.length >= MIN_SECRET_LENGTH ? [previousSecret] : [])]) {
    const expected = createHmac("sha256", candidate).update(message).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  if (!matched) return { state: "invalid", reason: "bad_signature" };

  const nowSeconds = (input.nowMs ?? Date.now()) / 1000;
  if (nowSeconds - payload.ts > WEBSITE_SIGNATURE_MAX_AGE_SECONDS) return { state: "invalid", reason: "expired" };
  if (payload.ts - nowSeconds > WEBSITE_SIGNATURE_MAX_FUTURE_SECONDS) return { state: "invalid", reason: "future" };

  // Only an authentic, in-window, correctly bound request reaches the one-time store, so unauthenticated traffic can never fill it.
  const consume = input.consumeNonce ?? consumeNonceInDatabase;
  const key = `nonce:v2:${input.companyId}:${payload.nonce}`;
  const expiresAt = new Date((payload.ts + WEBSITE_SIGNATURE_MAX_AGE_SECONDS + NONCE_RETENTION_EXTRA_SECONDS) * 1000);
  let fresh: boolean;
  try {
    fresh = await consume(key, expiresAt);
  } catch {
    return { state: "unavailable" };
  }
  if (!fresh) return { state: "invalid", reason: "replay" };

  return { state: "verified", visitor: visitorFromContextPayload(payload) };
}

// Whether a signature is mandatory lives in a module without database imports, so the startup check can use it too.
export { websiteSignatureRequired };
