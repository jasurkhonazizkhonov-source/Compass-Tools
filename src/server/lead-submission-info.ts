// What the SERVER learns about a lead-submitting request: the full client IP and
// the approximate, IP-derived location. Both come exclusively from the request's
// own trusted path — never from the JSON body or a form field a visitor (or a
// script POSTing directly to the public endpoint) could fill in:
//   • the IP via getClientIp(), which believes forwarded-for style headers only
//     when TRUSTED_PROXY / the Vercel runtime says a proxy we control overwrites
//     them, and rejects private/reserved/garbage values;
//   • the location via getRequestLocation(), which reads the platform's x-vercel-ip-*
//     headers only behind that same trust gate.
// When either cannot be determined it is simply absent — nothing is invented, and
// when neither is known no row is written at all.
import { getClientIp } from "@/lib/request-ip";
import { GEO_SOURCE, getRequestLocation } from "@/lib/request-geo";
import type { Prisma } from "@/generated/prisma/client";

export function buildLeadSubmissionInfoCreate(headerList: Headers, now: Date = new Date()): Prisma.LeadSubmissionInfoCreateWithoutLeadInput | undefined {
  const ip = getClientIp(headerList);
  const location = getRequestLocation(headerList);
  if (!ip && !location) return undefined;
  return {
    ipAddress: ip ?? null,
    ipVersion: ip ? (ip.includes(":") ? "v6" : "v4") : null,
    city: location?.city ?? null,
    region: location ? (location.region ?? location.regionCode ?? null) : null,
    country: location?.country ?? null,
    countryCode: location?.countryCode ?? null,
    timeZone: location?.timeZone ?? null,
    geoSource: location ? GEO_SOURCE : null,
    capturedAt: now,
  };
}
