// What the SERVER learns about a successful sign-in: the client IP and the approximate, IP-derived location — taken only
// from the request's own trusted path (the same getClientIp / getRequestLocation every other IP-bearing record uses: a
// forwarded-for style header is believed only when the trusted-proxy rule says a proxy we control set it). Never from the
// request body, a form field or JavaScript. Anything that cannot be determined is simply null — nothing is invented.
import { getClientIp } from "@/lib/request-ip";
import { getRequestLocation } from "@/lib/request-geo";

export type SignInContext = {
  ip: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timeZone: string | null;
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
  };
}

/**
 * Compact text for the Users table: "Frankfurt, Hesse, Germany" — only the parts that exist. Approximate by nature, so it never
 * pretends to be an address. Returns null when nothing is known (the caller shows a neutral state).
 */
export function formatSignInLocation(c: { city?: string | null; region?: string | null; country?: string | null; countryCode?: string | null }): string | null {
  const text = [c.city, c.region, c.country ?? c.countryCode].filter((p): p is string => !!p && p.trim().length > 0).join(", ");
  return text.length > 0 ? text : null;
}
