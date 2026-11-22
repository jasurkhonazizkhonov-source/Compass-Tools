// Authenticated "who really submitted this" context for server-to-server lead ingestion.
//
// The public company website's server calls the CRM's /api/public/lead-capture on a visitor's behalf, so from the
// CRM's side the connection (and every x-forwarded-for / x-vercel-ip-* header on it) describes THE WEBSITE'S SERVER,
// not the visitor. Believing those would store the wrong IP and location. Instead the website forwards what ITS edge
// observed in a signed envelope:
//
//   x-ct-visitor-context:   base64url(JSON { v:1, ts, ip?, city?, region?, country?, timezone? })   (raw Vercel header values)
//   x-ct-visitor-signature: hex( HMAC-SHA256( LEAD_INGEST_SECRET, <the context header exactly as sent> ) )
//
// The secret is shared only between the two servers, so a visitor or script POSTing directly to the public endpoint
// cannot forge an IP or location: without a valid signature the context is refused. A context that is present but cannot
// be verified (wrong/missing secret, bad signature, stale timestamp, malformed) yields NO IP and NO location — it is
// never allowed to fall back to the connection headers, which would record the website's own server. Replaying a
// captured envelope only re-sends the same visitor data; a duplicate submission is already a no-op (submission key).
//
// With no context headers at all the endpoint behaves as before: a direct visitor's own IP/location come from the
// trusted-proxy headers (request-ip.ts / request-geo.ts).
import { createHmac, timingSafeEqual } from "node:crypto";
import { isPrivateOrReservedIp, isValidIpAddress, normalizeIp } from "@/lib/request-ip";
import { CLOUDFLARE_GEO_SOURCE, GEO_SOURCE, readApproximateLocation, type ApproximateLocation } from "@/lib/request-geo";

/**
 * The only location sources the website may name in its signed context, each mapped to the stored label. The value is looked up here, never copied from
 * the payload, so a context can never inject an arbitrary text into the stored source. Anything else (or nothing: an older website) keeps the label
 * this CRM has always used for a signed context, "Vercel edge geolocation (approximate)".
 */
const CONTEXT_LOCATION_SOURCES: Readonly<Record<string, string>> = { vercel: GEO_SOURCE, cloudflare: CLOUDFLARE_GEO_SOURCE };

export const VISITOR_CONTEXT_HEADER = "x-ct-visitor-context";
export const VISITOR_SIGNATURE_HEADER = "x-ct-visitor-signature";
/** Longest clock difference between the two servers for which a signed context is accepted. */
export const VISITOR_CONTEXT_MAX_SKEW_SECONDS = 300;
const MAX_CONTEXT_BYTES = 2048;
const MIN_SECRET_LENGTH = 32;

/** Whether a usable LEAD_INGEST_SECRET is configured on THIS server (a boolean only — the value never leaves this module). */
export function isLeadIngestSecretConfigured(secret: string | undefined = process.env.LEAD_INGEST_SECRET): boolean {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

export type VisitorContextPayload = {
  v: 1;
  /** Unix seconds when the website signed it. */
  ts: number;
  ip?: string;
  /** Raw x-vercel-ip-* header values exactly as the website's edge supplied them (the city stays percent-encoded). */
  city?: string;
  region?: string;
  country?: string;
  timezone?: string;
  /** Which edge produced the location fields above: "cloudflare" or "vercel" (anything else is ignored). Optional, so an older website keeps working. */
  source?: string;
};

export type VisitorContextResult =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "verified"; ip?: string; location?: ApproximateLocation; /** The stored label for `location`; present only with a location. */ locationSource?: string };

export function signVisitorContext(payload: VisitorContextPayload, secret: string): { context: string; signature: string } {
  const context = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { context, signature: createHmac("sha256", secret).update(context).digest("hex") };
}

export function resolveVisitorContext(headers: Headers, nowMs: number = Date.now(), secret: string | undefined = process.env.LEAD_INGEST_SECRET): VisitorContextResult {
  const context = headers.get(VISITOR_CONTEXT_HEADER);
  const signature = headers.get(VISITOR_SIGNATURE_HEADER);
  if (!context && !signature) return { state: "absent" };
  if (!context || !signature || !secret || secret.length < MIN_SECRET_LENGTH || context.length > MAX_CONTEXT_BYTES) return { state: "invalid" };

  const expected = createHmac("sha256", secret).update(context).digest();
  const given = /^[0-9a-f]{64}$/i.test(signature) ? Buffer.from(signature, "hex") : null;
  if (!given || given.length !== expected.length || !timingSafeEqual(given, expected)) return { state: "invalid" };

  let payload: Partial<VisitorContextPayload>;
  try {
    payload = JSON.parse(Buffer.from(context, "base64url").toString("utf8"));
  } catch {
    return { state: "invalid" };
  }
  if (!payload || typeof payload !== "object" || payload.v !== 1 || typeof payload.ts !== "number" || !Number.isFinite(payload.ts)) return { state: "invalid" };
  if (Math.abs(nowMs / 1000 - payload.ts) > VISITOR_CONTEXT_MAX_SKEW_SECONDS) return { state: "invalid" };

  return { state: "verified", ...visitorFromContextPayload(payload) };
}

/**
 * The visitor facts of an ALREADY AUTHENTICATED context payload (v1 here, v2 in website-request-signature.ts). Even a correctly signed value is
 * validated like any other: shape, never a private/reserved address, location values only through the same reader the platform headers use, and the
 * location source only from the allow-list above.
 */
export function visitorFromContextPayload(payload: Partial<Pick<VisitorContextPayload, "ip" | "city" | "region" | "country" | "timezone" | "source">>): {
  ip?: string;
  location?: ApproximateLocation;
  locationSource?: string;
} {
  let ip: string | undefined;
  if (typeof payload.ip === "string") {
    const candidate = normalizeIp(payload.ip.trim());
    if (isValidIpAddress(candidate) && !isPrivateOrReservedIp(candidate)) ip = candidate;
  }
  const str = (v: unknown) => (typeof v === "string" && v.length <= 120 ? v : undefined);
  const geoHeaders = new Headers();
  const city = str(payload.city);
  const region = str(payload.region);
  const country = str(payload.country);
  const timezone = str(payload.timezone);
  if (city) geoHeaders.set("x-vercel-ip-city", city);
  if (region) geoHeaders.set("x-vercel-ip-country-region", region);
  if (country) geoHeaders.set("x-vercel-ip-country", country);
  if (timezone) geoHeaders.set("x-vercel-ip-timezone", timezone);
  const location = readApproximateLocation(geoHeaders);
  const named = typeof payload.source === "string" && Object.prototype.hasOwnProperty.call(CONTEXT_LOCATION_SOURCES, payload.source) ? CONTEXT_LOCATION_SOURCES[payload.source] : undefined;
  return { ip, location, ...(location ? { locationSource: named ?? GEO_SOURCE } : {}) };
}
