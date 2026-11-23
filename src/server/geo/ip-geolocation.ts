// Approximate, IP-derived location from a LOCAL MaxMind-format (.mmdb) city database — no third-party request is made when
// someone signs in, and the address never leaves this server.
//
// Why this exists: the CRM used to take location only from Vercel's edge headers (request-geo.ts). Anywhere else (a VPS behind
// Cloudflare, nginx, …) those headers do not exist, so the IP was stored but no location ever was — the Users page showed
// "Location unavailable" for every row. This module resolves the already-trusted client IP against a database file the operator
// installs (DB-IP "IP to City Lite" or MaxMind GeoLite2-City — both use the same format; see docs/GEOIP.md).
//
// Rules this module keeps:
//   • It is told an IP that the trusted-proxy rules already vetted (request-ip.ts getClientIp). It never reads headers itself.
//   • It NEVER throws and never makes a sign-in wait on anything but a local file read: a missing, unreadable, corrupt, wrong-type
//     or outdated database yields a clearly labelled "unresolved" result, never a guess.
//   • Only what the database actually returned is reported. A country-only record stays country-only. Nothing is invented.
//   • The file is re-checked (stat only) at most once a minute; when it has been replaced (monthly update) the new file is loaded
//     and swapped in without a restart, and a bad replacement keeps the previous database serving.
//   • Everything is an ESTIMATE of where the NETWORK is (VPNs, mobile networks, corporate gateways and IPv6 make it wrong or
//     coarse), never of where a person is.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Reader, CityResponse } from "mmdb-lib";
import { open } from "maxmind";
import { isPrivateOrReservedIp, isValidIpAddress, normalizeIp } from "@/lib/request-ip";
import { readUpdateStatus, type GeoIpUpdateStatus } from "@/server/geo/geoip-update-status";

export type IpLocation = {
  city: string | null;
  /** Human-readable first-level subdivision (state, province, …) as the database names it. */
  region: string | null;
  /** ISO 3166-2 subdivision code when the database supplies one. */
  regionCode: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2, upper-case. */
  countryCode: string | null;
  /** IANA zone when the database supplies one. */
  timeZone: string | null;
  /** City-level estimate; null when absent. Resolved for callers but deliberately not stored by the sign-in feature. */
  latitude: number | null;
  longitude: number | null;
  /** Radius (km) the database says the point is accurate within, when it says so (GeoLite2 does; DB-IP Lite does not). */
  accuracyRadiusKm: number | null;
};

export type UnresolvedReason =
  | "invalid-ip" // missing or not a valid IPv4/IPv6 address
  | "non-public-ip" // private, loopback, link-local, carrier-grade NAT… — an internal hop, never a visitor's place
  | "database-missing" // no database file at the configured path (or no path)
  | "database-error" // unreadable, corrupt, not an .mmdb, wrong type, or the lookup itself failed
  | "not-found" // the database has no record for this address
  | "no-location-data"; // a record exists but names no country/city/region

export type IpLookupResult =
  | {
      status: "resolved";
      location: IpLocation;
      /** Database product + build date, e.g. "DBIP-City-Lite (2026-11-01)". Stored next to the location it produced. */
      source: string;
      databaseBuiltAt: Date;
      /** True when the database is older than MAX_DATABASE_AGE_DAYS — still used, but flagged so it is not mistaken for current. */
      databaseStale: boolean;
    }
  | { status: "unresolved"; reason: UnresolvedReason };

/** A monthly database older than this has missed at least two updates. */
export const MAX_DATABASE_AGE_DAYS = 90;
/** The file is stat-ed at most this often to notice a replacement. */
const RECHECK_INTERVAL_MS = 60_000;
const TEXT_MAX = 80;

type Loaded = { reader: Reader<CityResponse>; mtimeMs: number; size: number; builtAt: Date; databaseType: string };

let current: Loaded | null = null;
let lastCheckAt = 0;
let lastLoadError: string | null = null;
/** The file stamp of a load that failed, so a corrupt file is not re-read (it can be 100+ MB) on every sign-in. */
let failedStamp: { mtimeMs: number; size: number } | null = null;
let loading: Promise<void> | null = null;
let warnedStale = false;
let warnedError = false;

/** Where the database file is expected. `GEOIP_DB_PATH` wins; otherwise `data/geoip/city.mmdb` under the working directory. */
export function geoipDatabasePath(): string {
  const configured = process.env.GEOIP_DB_PATH?.trim();
  return configured ? path.resolve(configured) : path.join(process.cwd(), "data", "geoip", "city.mmdb");
}

/** Forget the loaded database and all warnings. Tests only. */
export function resetIpGeolocationForTests() {
  current = null;
  lastCheckAt = 0;
  lastLoadError = null;
  failedStamp = null;
  loading = null;
  warnedStale = false;
  warnedError = false;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Printable text only, bounded length: this ends up in the CRM and must never carry control characters.
  const text = value.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= TEXT_MAX ? text : null;
}

/**
 * DB-IP names some cities with a district or street in brackets ("San Jose (Tasman and Zanker)", "Berkeley (North Berkeley)").
 * That is false precision for a network-derived estimate - and it reads as an address - so only the city itself is kept.
 */
function cityName(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  return text.replace(/\s*\([^)]*\)\s*$/, "").trim() || null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A city database (DB-IP "City", GeoLite2/GeoIP2 "City"). A country- or ASN-only file cannot answer a city lookup honestly. */
function isCityDatabase(databaseType: string): boolean {
  return /city/i.test(databaseType);
}

async function loadFrom(file: string, stat: { mtimeMs: number; size: number }): Promise<Loaded> {
  const reader = (await open<CityResponse>(file)) as Reader<CityResponse>;
  const md = reader.metadata;
  if (!isCityDatabase(md.databaseType)) throw new Error(`database type "${md.databaseType}" is not a City database`);
  if (md.ipVersion !== 6 && md.ipVersion !== 4) throw new Error("database reports an unsupported IP version");
  return { reader, mtimeMs: stat.mtimeMs, size: stat.size, builtAt: md.buildEpoch, databaseType: md.databaseType };
}

/** Loads on first use and re-loads when the file has changed. Never throws; a failed (re)load keeps whatever was loaded before. */
async function ensureDatabase(): Promise<void> {
  const now = Date.now();
  if (current && now - lastCheckAt < RECHECK_INTERVAL_MS) return;
  if (loading) {
    // Someone else is loading right now. Serve the old database meanwhile if there is one; otherwise wait for it.
    if (!current) await loading;
    return;
  }
  loading = (async () => {
    const file = geoipDatabasePath();
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error("path is not a file");
      if (current && current.mtimeMs === stat.mtimeMs && current.size === stat.size) return; // unchanged
      if (failedStamp && failedStamp.mtimeMs === stat.mtimeMs && failedStamp.size === stat.size) return; // this exact file already failed to load
      try {
        current = await loadFrom(file, stat);
        lastLoadError = null;
        failedStamp = null;
        warnedError = false;
      } catch (loadError) {
        failedStamp = { mtimeMs: stat.mtimeMs, size: stat.size };
        throw loadError;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      lastLoadError = code === "ENOENT" ? "missing" : "error";
      if (lastLoadError === "error" && !warnedError) {
        warnedError = true;
        // The message names the failure, never any data from the file.
        console.warn(`[ip-geolocation] could not load the geolocation database${current ? " (keeping the previously loaded one)" : ""}: ${(error as Error)?.message ?? "unknown error"}`);
      }
    } finally {
      lastCheckAt = Date.now();
      loading = null;
    }
  })();
  await loading;
}

export type GeoIpDatabaseState = "ready" | "stale" | "missing" | "unusable";
export type GeoIpDatabaseStatus = {
  state: GeoIpDatabaseState;
  databaseType?: string;
  /** When the vendor built the data (from the file's own metadata). */
  builtAt?: Date;
  ageDays?: number;
  /** When the file was put in place here (the file's modification time). */
  installedAt?: Date;
  /** The outcome of the last attempt to update it, when the update command has run against this location. Present only when there is a record. */
  update?: GeoIpUpdateStatus;
};

/**
 * What the local database looks like right now, for System Health and /api/health - the very same loader the lookups use, so what is reported is what is served:
 *   ready    - a City database is loaded and no older than MAX_DATABASE_AGE_DAYS;
 *   stale    - loaded and used, but older than that (updates were missed);
 *   missing  - there is no file at the configured path: locations can only be country-level (from the edge, if any);
 *   unusable - a file exists but cannot be used (unreadable, corrupt, not an .mmdb, not a City database).
 * Never throws and never reports a path, an address or any record.
 */
export async function getGeoIpDatabaseStatus(): Promise<GeoIpDatabaseStatus> {
  const update = await readUpdateStatus(geoipDatabasePath()); // never throws; null without a record
  const withUpdate = <T extends GeoIpDatabaseStatus>(s: T): T => (update ? { ...s, update } : s);
  try {
    await ensureDatabase();
  } catch {
    return withUpdate({ state: "unusable" });
  }
  if (!current) return withUpdate({ state: lastLoadError === "error" ? "unusable" : "missing" });
  const ageDays = Math.floor((Date.now() - current.builtAt.getTime()) / 86_400_000);
  return withUpdate({
    state: ageDays > MAX_DATABASE_AGE_DAYS ? ("stale" as const) : ("ready" as const),
    databaseType: current.databaseType,
    builtAt: current.builtAt,
    ageDays,
    installedAt: new Date(current.mtimeMs),
  });
}

/** Resolves a (trusted-path) client IP to an approximate location. Never throws. */
export async function lookupIpLocation(rawIp: string | null | undefined): Promise<IpLookupResult> {
  const trimmed = typeof rawIp === "string" ? rawIp.trim() : "";
  if (!trimmed) return { status: "unresolved", reason: "invalid-ip" };
  const ip = normalizeIp(trimmed); // an IPv4-mapped IPv6 address ("::ffff:203.0.113.9") is looked up as the IPv4 it is
  if (!isValidIpAddress(ip)) return { status: "unresolved", reason: "invalid-ip" };
  if (isPrivateOrReservedIp(ip)) return { status: "unresolved", reason: "non-public-ip" };

  try {
    await ensureDatabase();
  } catch {
    return { status: "unresolved", reason: "database-error" };
  }
  if (!current) return { status: "unresolved", reason: lastLoadError === "missing" || lastLoadError === null ? "database-missing" : "database-error" };

  let record: CityResponse | null;
  try {
    record = current.reader.get(ip);
  } catch {
    return { status: "unresolved", reason: "database-error" };
  }
  if (!record) return { status: "unresolved", reason: "not-found" };

  const subdivision = record.subdivisions?.[0];
  const location: IpLocation = {
    city: cityName(record.city?.names?.en),
    region: cleanText(subdivision?.names?.en),
    regionCode: cleanText(subdivision?.iso_code),
    country: cleanText(record.country?.names?.en),
    countryCode: ((c) => (c && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : null))(cleanText(record.country?.iso_code)),
    timeZone: cleanText(record.location?.time_zone),
    latitude: finite(record.location?.latitude),
    longitude: finite(record.location?.longitude),
    accuracyRadiusKm: finite(record.location?.accuracy_radius),
  };
  // A record that names nothing a person could read is not a location.
  if (!location.city && !location.region && !location.country && !location.countryCode) return { status: "unresolved", reason: "no-location-data" };

  const ageDays = (Date.now() - current.builtAt.getTime()) / 86_400_000;
  const databaseStale = ageDays > MAX_DATABASE_AGE_DAYS;
  if (databaseStale && !warnedStale) {
    warnedStale = true;
    console.warn(`[ip-geolocation] the geolocation database is ${Math.floor(ageDays)} days old (limit ${MAX_DATABASE_AGE_DAYS}); results are still used but may be out of date. See docs/GEOIP.md.`);
  }
  return {
    status: "resolved",
    location,
    source: `${current.databaseType} (${current.builtAt.toISOString().slice(0, 10)})`,
    databaseBuiltAt: current.builtAt,
    databaseStale,
  };
}
