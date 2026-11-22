// Completing a PARTIAL location (a country with no city) from the local geolocation database. A separate module so that everything that already stubs
// `lookupIpLocation` (ip-geolocation.ts) exercises this logic too.
import { lookupIpLocation } from "@/server/geo/ip-geolocation";

export type KnownLocation = {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  countryCode?: string | null;
  timeZone?: string | null;
};
export type CompletedLocation = {
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  timeZone: string | null;
  /** The label stored next to the location. Names every origin that contributed, so a database value is never credited to the edge (or the reverse). */
  source: string | null;
  /** True only when the local database added at least one field that was missing. */
  completedFromDatabase: boolean;
};

const SOURCE_MAX = 120;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Many requests arrive with an INCOMPLETE location: a signed website context or an edge header that names only the country (Cloudflare's CF-IPCountry is the usual one), or
 * a country plus a region code but no city. Treating that as "already known" used to skip the local database altogether, so the record stayed country-only although the
 * same database knows the city and region. A location that already has a CITY is left exactly as the platform gave it. This asks the local database about the already-trusted IP and fills ONLY the fields that are missing, and only when its answer agrees with what is
 * already known:
 *   - a different country (by code, or by name when there is no code) -> nothing is merged: two sources that disagree are not blended into one place;
 *   - a different region (compared with the database's region name and its subdivision code) -> likewise nothing is merged;
 *   - a field that is already known is never replaced.
 * Nothing is invented: a database that has no record, is missing, corrupt or timed out leaves the input exactly as it was. Never throws. The IP never leaves this server.
 */
export async function completeLocationFromDatabase(rawIp: string | null | undefined, known: KnownLocation, knownSource: string | null = null): Promise<CompletedLocation> {
  const base: CompletedLocation = {
    city: known.city ?? null,
    region: known.region ?? null,
    country: known.country ?? null,
    countryCode: known.countryCode ? known.countryCode.toUpperCase() : null,
    timeZone: known.timeZone ?? null,
    source: knownSource,
    completedFromDatabase: false,
  };
  if (!rawIp || base.city) return base; // nothing to look up, or the platform already named a city
  try {
    const found = await lookupIpLocation(rawIp);
    if (found?.status !== "resolved") return base;
    // A provider answer is data from outside this function: anything that is not a location object is ignored, and each field must be a string (or it counts as absent).
    if (!found.location || typeof found.location !== "object") return base;
    const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
    const l = {
      city: text(found.location.city),
      region: text(found.location.region),
      regionCode: text(found.location.regionCode),
      country: text(found.location.country),
      countryCode: ((c) => (c && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : null))(text(found.location.countryCode)),
      timeZone: text(found.location.timeZone),
    };
    if (!l.city && !l.region && !l.regionCode && !l.country && !l.countryCode) return base;
    if (base.countryCode && l.countryCode && base.countryCode !== l.countryCode) return base;
    if (!base.countryCode && base.country && l.country && !same(base.country, l.country)) return base;
    if (base.region && (l.region || l.regionCode) && !(l.region && same(base.region, l.region)) && !(l.regionCode && same(base.region, l.regionCode))) return base;

    const merged = {
      city: base.city ?? l.city,
      region: base.region ?? l.region ?? l.regionCode,
      country: base.country ?? l.country,
      countryCode: base.countryCode ?? l.countryCode,
      timeZone: base.timeZone ?? l.timeZone,
    };
    const added = (Object.keys(merged) as (keyof typeof merged)[]).some((k) => merged[k] !== base[k]);
    if (!added) return base;
    const hadSomething = !!(base.city || base.region || base.country || base.countryCode || base.timeZone);
    const dbSource = typeof found.source === "string" && found.source ? found.source : "local geolocation database";
    const source = (hadSomething && knownSource ? `${knownSource} + ${dbSource}` : dbSource).slice(0, SOURCE_MAX);
    return { ...merged, source, completedFromDatabase: true };
  } catch {
    return base;
  }
}
