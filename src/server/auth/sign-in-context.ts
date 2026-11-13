// What the SERVER learns about a successful sign-in: the client IP and the approximate, IP-derived location — taken only
// from the request's own trusted path (the same getClientIp / getRequestLocation every other IP-bearing record uses: a
// forwarded-for style header is believed only when the trusted-proxy rule says a proxy we control set it). Never from the
// request body, a form field or JavaScript. Anything that cannot be determined is simply null — nothing is invented.
import { getClientIp, trustedProxyMode } from "@/lib/request-ip";
import { getRequestLocation, geoSourceOf } from "@/lib/request-geo";
import { lookupIpLocation } from "@/server/geo/ip-geolocation";

export type SignInContext = {
  ip: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timeZone: string | null;
  /** Where the location above came from (e.g. "DBIP-City-Lite (2026-11-01)"); null when there is no location. */
  locationSource: string | null;
  /** When the location was resolved; null when there is no location. */
  locationResolvedAt: Date | null;
};

export function captureSignInContext(headerList: Headers): SignInContext {
  const ip = getClientIp(headerList) ?? null;
  const location = getRequestLocation(headerList);
  return {
    ip,
    city: location?.city ?? null,
    region: location ? (location.region ?? location.regionCode ?? null) : null,
    country: location?.country ?? null,
    countryCode: location?.countryCode ?? null,
    timeZone: location?.timeZone ?? null,
    locationSource: location ? geoSourceOf(location) : null,
    locationResolvedAt: location ? new Date() : null,
  };
}

/**
 * captureSignInContext plus the local geolocation database. Order of preference, each only if the one before found nothing:
 *   1. the platform's own geo headers (Vercel; read only when the trusted-proxy rule says Vercel set them) — unchanged behaviour;
 *   2. the LOCAL database, looked up by the trusted-path IP only — so a request with no trustworthy IP is never geolocated, and a
 *      forged forwarded-for header (which getClientIp refuses) can never pick someone else's location;
 *   3. when Cloudflare is the trusted proxy: the country Cloudflare itself attached (CF-IPCountry), country only.
 * Never throws: a failure anywhere leaves the location fields null (the Users page then says "Location unavailable") and the
 * sign-in itself is unaffected.
 */
export async function resolveSignInContext(headerList: Headers): Promise<SignInContext> {
  const base = captureSignInContext(headerList);
  if (base.city || base.region || base.country || base.countryCode) return base;
  if (!base.ip) return base;
  try {
    const found = await lookupIpLocation(base.ip);
    if (found.status === "resolved") {
      const l = found.location;
      return {
        ...base,
        city: l.city,
        region: l.region ?? l.regionCode,
        country: l.country,
        countryCode: l.countryCode,
        timeZone: l.timeZone,
        locationSource: found.source,
        locationResolvedAt: new Date(),
      };
    }
  } catch {
    // fall through to the edge-supplied country, if any
  }
  const edgeCountry = cloudflareCountry(headerList);
  return edgeCountry ? { ...base, ...edgeCountry } : base;
}

const CLOUDFLARE_COUNTRY_SOURCE = "Cloudflare edge country (CF-IPCountry)";

/** CF-IPCountry, believed only when Cloudflare is the configured trusted proxy. "XX" (unknown) and "T1" (Tor) name no place. */
function cloudflareCountry(headerList: Headers): Pick<SignInContext, "country" | "countryCode" | "locationSource" | "locationResolvedAt"> | null {
  if (trustedProxyMode() !== "cloudflare") return null;
  const code = headerList.get("cf-ipcountry")?.trim().toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return null;
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
  } catch {
    name = undefined;
  }
  return { country: name && name !== code ? name : null, countryCode: code, locationSource: CLOUDFLARE_COUNTRY_SOURCE, locationResolvedAt: new Date() };
}

/**
 * Compact text for the Users table: "Frankfurt, Hesse, Germany" — only the parts that exist. Approximate by nature, so it never
 * pretends to be an address. Returns null when nothing is known (the caller shows a neutral state).
 */
export function formatSignInLocation(c: { city?: string | null; region?: string | null; country?: string | null; countryCode?: string | null }): string | null {
  const parts = [c.city, c.region, c.country ?? c.countryCode]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    // "Singapore, Singapore, Singapore" is noise: a part that repeats the one before it is dropped.
    .filter((p, i, all) => i === 0 || p.toLowerCase() !== all[i - 1].toLowerCase());
  return parts.length > 0 ? parts.join(", ") : null;
}
