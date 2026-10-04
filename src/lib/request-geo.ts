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
};

export const GEO_SOURCE = "Vercel edge geolocation (approximate)";

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
 * The location to store with a request-derived record, or undefined. Honours the
 * trusted-proxy gate described in the module comment: with no trusted Vercel edge
 * in front of the app nothing is read, whatever headers the request carries.
 */
export function getRequestLocation(headerList: Headers): ApproximateLocation | undefined {
  if (trustedProxyMode() !== "vercel") return undefined;
  return readApproximateLocation(headerList);
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
    geoSource: location ? GEO_SOURCE : null,
  };
}
