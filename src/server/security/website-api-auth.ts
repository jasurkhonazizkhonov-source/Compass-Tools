import { createHash, timingSafeEqual } from "node:crypto";

// Credential for the SERVER-TO-SERVER website API (POST /api/v1/website/flight-inquiries, docs/WEBSITE_LEAD_API.md).
//
// The BusinessFlights.travel website's BACKEND presents a dedicated bearer key. It is held only in server-side environment variables
// (never NEXT_PUBLIC_*, never in the repository, a client bundle, a response or a log) and is separate from every other secret
// (CRON_SECRET, LEAD_INGEST_SECRET): leaking or rotating one never affects the others.
//
//   WEBSITE_API_KEY         the current key
//   WEBSITE_API_KEY_NEXT    optional second key, accepted at the same time, for rotation WITHOUT downtime:
//                           1) set _NEXT to the new value on the CRM and restart it, 2) switch the website to the new value,
//                           3) move the new value into WEBSITE_API_KEY and remove _NEXT.
//   WEBSITE_API_COMPANY_ID  the tenant the API creates leads for (default "default-company", the single seeded company). The CALLER
//                           cannot choose a company: the credential fixes it, so a leaked key can never write into another tenant.
//
// A key shorter than 32 characters is treated as NOT configured (a guessable value is worse than a disabled API). Comparison is
// constant-time over fixed-length digests, against every configured key, with no early exit.

export const WEBSITE_API_MIN_KEY_LENGTH = 32;
export const WEBSITE_API_DEFAULT_COMPANY_ID = "default-company";
const MAX_PRESENTED_TOKEN_LENGTH = 512;

type Env = Record<string, string | undefined>;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function configuredKeys(env: Env): string[] {
  const keys = [env.WEBSITE_API_KEY, env.WEBSITE_API_KEY_NEXT]
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => k.length >= WEBSITE_API_MIN_KEY_LENGTH);
  return [...new Set(keys)];
}

/** Whether at least one usable key is configured. A boolean only — the value never leaves this module. */
export function isWebsiteApiConfigured(env: Env = process.env): boolean {
  return configuredKeys(env).length > 0;
}

/** The company every API-created lead belongs to. */
export function websiteApiCompanyId(env: Env = process.env): string {
  const id = env.WEBSITE_API_COMPANY_ID?.trim();
  return id ? id : WEBSITE_API_DEFAULT_COMPANY_ID;
}

export type WebsiteApiAuth = "ok" | "unauthorized" | "not_configured";

/** Checks `Authorization: Bearer <key>`. Never throws, never logs, never reveals which part was wrong. */
export function authenticateWebsiteApi(headers: Headers, env: Env = process.env): WebsiteApiAuth {
  const keys = configuredKeys(env);
  if (keys.length === 0) return "not_configured";

  const header = headers.get("authorization") ?? "";
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  // A missing / malformed / oversized header goes through the same comparisons (against an empty value), so it is not distinguishable
  // by timing from a wrong key.
  const usable = !!token && token.length <= MAX_PRESENTED_TOKEN_LENGTH;
  const presented = digest(usable ? (token as string) : "");
  let ok = false;
  for (const key of keys) ok = timingSafeEqual(presented, digest(key)) || ok;
  return usable && ok ? "ok" : "unauthorized";
}

/**
 * Whether the request arrived through Cloudflare's public edge (the tunnel stamps CF-Ray / CF-Connecting-IP on every request). The website
 * calls the CRM over the PRIVATE Docker network, where no such header exists; a request carrying one came in through the public
 * hostname and is refused unless the operator explicitly allows it (WEBSITE_API_ALLOW_PUBLIC_ROUTE=true, for a website hosted
 * elsewhere that must call the public URL). Defence in depth only — the bearer key remains the authentication.
 */
export function arrivedViaPublicEdge(headers: Headers): boolean {
  return headers.has("cf-ray") || headers.has("cf-connecting-ip") || headers.has("cf-visitor");
}

export function publicRouteAllowed(env: Env = process.env): boolean {
  return env.WEBSITE_API_ALLOW_PUBLIC_ROUTE?.trim().toLowerCase() === "true";
}
