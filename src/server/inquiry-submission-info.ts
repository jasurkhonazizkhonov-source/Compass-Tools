// What the SERVER learns about the request that submitted a public inquiry (Business Flights "Get In Touch" or "CRM Inquiries"): the full client IP
// and the approximate, IP-derived location. Both come only from the request's own trusted path - never from the JSON body or a form field, which
// a visitor or a script POSTing straight to the public endpoint could fill in.
//
// Two very different callers reach these endpoints, and they must not be confused:
//   * a VISITOR'S BROWSER posting directly (the CRM's own public inquiry page): the connection IS the visitor, so the IP comes from getClientIp()
//     (forwarded-for style headers are believed only when the trusted-proxy rule says a proxy we control set them; private/reserved/garbage values
//     are refused) and the location from the platform headers, else the LOCAL database, else Cloudflare's country - the same order sign-in uses
//     (resolveSignInContext);
//   * the WEBSITE'S SERVER posting on a visitor's behalf (Business Flights contact form): the connection and every forwarded header describe the
//     website's own server, so they are NEVER consulted. The only trustworthy source is the signed visitor context the website attaches
//     (lead-ingest-context.ts, HMAC with LEAD_INGEST_SECRET). Verified -> its IP and location; present but unverifiable -> nothing; absent -> nothing
//     (an honest "not recorded" - the website must send the signed context for this to be filled, which is website-side work).
// When nothing trustworthy is known no row is written at all. A failed geolocation never loses the IP and never fails the inquiry.
import { resolveSignInContext } from "@/server/auth/sign-in-context";
import { resolveVisitorContext } from "@/server/lead-ingest-context";
import type { VerifiedVisitor } from "@/server/website-request-signature";
import { completeLocationFromDatabase } from "@/server/geo/complete-location";
import { GEO_SOURCE } from "@/lib/request-geo";
import type { Prisma } from "@/generated/prisma/client";

export type InquirySubmissionInfoCreate = Prisma.InquirySubmissionInfoCreateWithoutInquiryInput;

export async function buildInquirySubmissionInfo(
  headerList: Headers,
  // `verifiedVisitor`: the visitor facts of a request whose v2 signature the CALLER already verified (website-request-signature.ts); it replaces the header lookup.
  options: { serverToServer: boolean; verifiedVisitor?: VerifiedVisitor },
  now: Date = new Date()
): Promise<InquirySubmissionInfoCreate | undefined> {
  try {
    const visitor = options.verifiedVisitor ? ({ state: "verified", ...options.verifiedVisitor } as const) : resolveVisitorContext(headerList, now.getTime());

    if (visitor.state === "verified") {
      const ip = visitor.ip ?? null;
      let city = visitor.location?.city ?? null;
      let region = visitor.location ? (visitor.location.region ?? visitor.location.regionCode ?? null) : null;
      let country = visitor.location?.country ?? null;
      let countryCode = visitor.location?.countryCode ?? null;
      let timeZone = visitor.location?.timeZone ?? null;
      // The label the website named in its signed context ("Cloudflare edge geolocation (approximate)" for the VPS), never an assumption of our own platform.
      let geoSource: string | null = visitor.location ? (visitor.locationSource ?? GEO_SOURCE) : null;
      if (ip) {
        // The website supplied the IP but no location, or only a partial one (often just Cloudflare's country): fill what is MISSING from the local database (the
        // address never leaves this server), only when it agrees with what the website sent. The label then names both origins.
        const done = await completeLocationFromDatabase(ip, { city, region, country, countryCode, timeZone }, geoSource);
        if (done.completedFromDatabase) ({ city, region, country, countryCode, timeZone, source: geoSource } = done);
      }
      return finish({ ip, city, region, country, countryCode, timeZone, geoSource }, now);
    }

    // A signed context that is present but cannot be verified, or any server-to-server call without one, yields NOTHING: the connection headers would
    // describe the website's own server, which is not the visitor.
    if (visitor.state === "invalid" || options.serverToServer) return undefined;

    // A visitor posting directly: trusted-proxy IP, then platform headers -> local database -> Cloudflare country (see resolveSignInContext).
    const ctx = await resolveSignInContext(headerList);
    return finish({ ip: ctx.ip, city: ctx.city, region: ctx.region, country: ctx.country, countryCode: ctx.countryCode, timeZone: ctx.timeZone, geoSource: ctx.locationSource }, now);
  } catch {
    // Recording where an inquiry came from is best-effort by design: it must never cost the business a real inquiry.
    return undefined;
  }
}

function finish(
  v: { ip: string | null; city: string | null; region: string | null; country: string | null; countryCode: string | null; timeZone: string | null; geoSource: string | null },
  now: Date
): InquirySubmissionInfoCreate | undefined {
  const hasLocation = !!(v.city || v.region || v.country || v.countryCode || v.timeZone);
  if (!v.ip && !hasLocation) return undefined;
  return {
    ipAddress: v.ip,
    ipVersion: v.ip ? (v.ip.includes(":") ? "v6" : "v4") : null,
    city: v.city,
    region: v.region,
    country: v.country,
    countryCode: v.countryCode,
    timeZone: v.timeZone,
    geoSource: hasLocation ? v.geoSource : null,
    capturedAt: now,
  };
}
