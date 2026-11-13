// Approximate, IP-derived location — read from the geolocation headers Vercel's
// edge network adds to every request it serves (x-vercel-ip-*). The same rule the
// public website applies to its own lead form, so a lead captured by either path
// and a booking signed through the CRM carry location in one shape.
//
// Why no external IP-intelligence provider: the platform already supplies the
// useful part (city, region, country, time zone) with no credentials, no extra
// network call, no added latency and no failure mode that could touch a booking
// or a lead — and it avoids sending every customer's IP address to a third party.
// There is therefore no API key anywhere to protect, and the lookup is performed
// by the server's own request handling, never by the browser. What the platform
// does NOT supply (network owner / ISP, ASN, accuracy radius) is not captured and
// not guessed.
//
// Everything here is an ESTIMATE of where the NETWORK is, never of where the
// person is: VPNs, proxies, mobile networks, corporate gateways, privacy relays
// and IPv6 all make it wrong or coarse. Values are kept as the platform gave them
// (validated for shape, never "improved"); anything absent or malformed is simply
// omitted so the UI can say "Not available" instead of inventing a place. Precise
// coordinates and postal codes are deliberately not read — they would add
// precision this data does not have.
//
// Trust: these headers are only trustworthy where Vercel's edge itself sets them
// (a client could send them to a directly reachable server). They are therefore
// read ONLY when the existing trusted-proxy resolution (request-ip.ts) says the
// platform is "vercel" — the same gate that decides whether x-forwarded-for may be
// believed.
import { trustedProxyMode } from "@/lib/request-ip";

export type ApproximateLocation = {
  city?: string;
  /** ISO 3166-2 subdivision code exactly as supplied (e.g. "CA", "NSW"). */
  regionCode?: string;
  /** Human-readable region where the name is known (US states, Canadian provinces, Australian states); otherwise undefined and only the code is shown. */
  region?: string;
  country?: string;
  /** ISO 3166-1 alpha-2, upper-case. */
  countryCode?: string;
  /** IANA zone, e.g. "America/Los_Angeles". */
  timeZone?: string;
  /** Which edge produced this location, when it is not Vercel (see geoSourceOf). Never read from a request body; set only by the readers below. */
  source?: string;
};

export const GEO_SOURCE = "Vercel edge geolocation (approximate)";
export const CLOUDFLARE_GEO_SOURCE = "Cloudflare edge geolocation (approximate)";

/** The stored "where did this location come from" label for a location read from request headers. */
export function geoSourceOf(location: ApproximateLocation): string {
  return location.source ?? GEO_SOURCE;
}

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico",
  NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
};
const CA_PROVINCES: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia",
  NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};
const AU_STATES: Record<string, string> = {
  ACT: "Australian Capital Territory", NSW: "New South Wales", NT: "Northern Territory", QLD: "Queensland", SA: "South Australia",
  TAS: "Tasmania", VIC: "Victoria", WA: "Western Australia",
};
const REGION_NAMES: Record<string, Record<string, string>> = { US: US_STATES, CA: CA_PROVINCES, AU: AU_STATES };

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function cleanText(value: string | null, max: number): string | undefined {
  if (!value) return undefined;
  const decoded = decode(value);
  if (!decoded) return undefined;
  // Printable text only — no control characters, bounded length: this ends up in
  // the CRM and must never carry markup-significant surprises.
  const trimmed = decoded.replace(/\p{Cc}+/gu, " ").trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function countryName(code: string): string | undefined {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
    // Intl echoes the code back for a region it doesn't know — that is "unknown", not a name.
    return name && name !== code ? name : undefined;
  } catch {
    return undefined;
  }
}

function validTimeZone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
}

/** Reads Vercel's geolocation headers. Returns undefined when none of them yielded a usable value. */
export function readApproximateLocation(headerList: Headers): ApproximateLocation | undefined {
  const countryRaw = headerList.get("x-vercel-ip-country")?.trim().toUpperCase();
  const countryCode = countryRaw && /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : undefined;
  const regionRaw = headerList.get("x-vercel-ip-country-region")?.trim().toUpperCase();
  const regionCode = regionRaw && /^[A-Z0-9]{1,4}$/.test(regionRaw) ? regionRaw : undefined;

  const location: ApproximateLocation = {
    city: cleanText(headerList.get("x-vercel-ip-city"), 80),
    regionCode,
    region: countryCode && regionCode ? REGION_NAMES[countryCode]?.[regionCode] : undefined,
    country: countryCode ? countryName(countryCode) : undefined,
    countryCode,
    timeZone: validTimeZone(cleanText(headerList.get("x-vercel-ip-timezone"), 64)),
  };
  if (!Object.values(location).some((v) => v !== undefined)) return undefined;
  // Drop undefined keys so a stored/serialised object only holds what was obtained.
  return Object.fromEntries(Object.entries(location).filter(([, v]) => v !== undefined)) as ApproximateLocation;
}

/**
 * Reads the visitor-location headers Cloudflare adds when the zone's "Add visitor location headers" managed transform is enabled (it is OFF by default;
 * only CF-IPCountry is always present): CF-IPCountry (ISO 3166-1 alpha-2; "XX" = unknown and "T1" = Tor name no place), CF-IPCity, CF-Region (name),
 * CF-Region-Code, CF-Timezone. Latitude/longitude (CF-IPLatitude/-Longitude) and the postal code are deliberately NOT read or stored - the established
 * policy for every IP-derived record in this CRM is "no coordinates"; they would add precision this data does not have.
 *
 * Returns a location only when it says MORE than the country (a city or a region). A country-only answer is left to the existing last-resort path
 * (resolveSignInContext: local geolocation database first, then CF-IPCountry), so enabling nothing in Cloudflare changes nothing here.
 */
export function readCloudflareLocation(headerList: Headers): ApproximateLocation | undefined {
  const countryRaw = headerList.get("cf-ipcountry")?.trim().toUpperCase();
  const countryCode = countryRaw && /^[A-Z]{2}$/.test(countryRaw) && countryRaw !== "XX" && countryRaw !== "T1" ? countryRaw : undefined;
  const regionCodeRaw = headerList.get("cf-region-code")?.trim().toUpperCase();
  const regionCode = regionCodeRaw && /^[A-Z0-9]{1,4}$/.test(regionCodeRaw) ? regionCodeRaw : undefined;
  const city = cleanText(headerList.get("cf-ipcity"), 80);
  const regionName = cleanText(headerList.get("cf-region"), 80);
  const region = regionName ?? (countryCode && regionCode ? REGION_NAMES[countryCode]?.[regionCode] : undefined);
  if (!city && !region && !regionCode) return undefined; // country only (or nothing): not enough to be "the" location

  const location: ApproximateLocation = {
    city,
    regionCode,
    region,
    country: countryCode ? countryName(countryCode) : undefined,
    countryCode,
    timeZone: validTimeZone(cleanText(headerList.get("cf-timezone"), 64)),
    source: CLOUDFLARE_GEO_SOURCE,
  };
  return Object.fromEntries(Object.entries(location).filter(([, v]) => v !== undefined)) as ApproximateLocation;
}

/**
 * The location to store with a request-derived record, or undefined. Honours the trusted-proxy gate described in the module comment: a platform's
 * location headers are read ONLY when the trusted-proxy resolution says that platform is in front of the app ("vercel" -> x-vercel-ip-*,
 * "cloudflare" -> CF-IP*); in every other mode nothing is read, whatever headers the request carries.
 */
export function getRequestLocation(headerList: Headers): ApproximateLocation | undefined {
  const mode = trustedProxyMode();
  if (mode === "vercel") return readApproximateLocation(headerList);
  if (mode === "cloudflare") return readCloudflareLocation(headerList);
  return undefined;
}

/** "San Francisco, California, United States" — only the parts that exist, comma-joined. */
export function formatLocation(location: ApproximateLocation): string {
  return [location.city, location.region ?? location.regionCode, location.country ?? location.countryCode].filter(Boolean).join(", ");
}

/** The flat columns IpCapture stores (all null when nothing was supplied). */
export function locationToIpCaptureColumns(location: ApproximateLocation | undefined) {
  return {
    geoCity: location?.city ?? null,
    geoRegion: location ? (location.region ?? location.regionCode ?? null) : null,
    geoCountry: location?.country ?? null,
    geoCountryCode: location?.countryCode ?? null,
    geoTimeZone: location?.timeZone ?? null,
    geoSource: location ? geoSourceOf(location) : null,
  };
}
