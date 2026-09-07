"use server";

import { prisma } from "@/lib/prisma";
import airportsData from "@/data/reference/airports.json";
import airlinesData from "@/data/reference/airlines.json";
import aircraftData from "@/data/reference/aircraft.json";

type BundledAirport = { iata: string; icao: string | null; name: string; city: string; country: string; countryCode: string | null; latitude: number | null; longitude: number | null; timezone: string | null };
type BundledAirline = { iata: string | null; icao: string | null; name: string; country: string | null; isActive: boolean };
type BundledAircraft = { code: string | null; manufacturer: string; model: string; displayName: string };

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

let seedPromise: Promise<void> | null = null;

/**
 * Self-healing guard — makes every lookup below independent of whether
 * anyone remembered to run `npm run db:seed:reference-data` against the
 * currently-connected Postgres database. Called at the top of every
 * exported function in this file; after the first call in a given server
 * process this resolves immediately (memoized via `seedPromise`), unless a
 * reference table is found short of the bundled dataset's row count, in
 * which case it bulk-inserts the missing rows from src/data/reference/
 * *.json — the exact same filtered dataset `prisma/seed.ts` produces from
 * the original CSV/.dat source files (see prisma/seed-data/
 * generate-json.ts), via the same idempotent `createMany({ skipDuplicates:
 * true })` pattern seed.ts already uses. A truly fresh, empty database
 * self-heals on its very first reference-data call; an already-seeded
 * database pays only three fast COUNT queries, once, per process.
 */
function ensureReferenceDataSeeded(): Promise<void> {
  if (!seedPromise) seedPromise = doEnsureReferenceDataSeeded();
  return seedPromise;
}

async function doEnsureReferenceDataSeeded(): Promise<void> {
  const airports = airportsData as BundledAirport[];
  const airlines = airlinesData as BundledAirline[];
  const aircraft = aircraftData as BundledAircraft[];

  const [airportCount, airlineCount, aircraftCount] = await Promise.all([
    prisma.airport.count(),
    prisma.airline.count(),
    prisma.aircraftType.count(),
  ]);

  const tasks: Promise<unknown>[] = [];
  if (airportCount < airports.length) tasks.push(seedAirportsFromBundle(airports));
  if (airlineCount < airlines.length) tasks.push(seedAirlinesFromBundle(airlines));
  if (aircraftCount < aircraft.length) tasks.push(seedAircraftFromBundle(aircraft));
  if (tasks.length > 0) await Promise.all(tasks);
}

async function seedAirportsFromBundle(airports: BundledAirport[]): Promise<void> {
  for (const batch of chunk(airports, 2000)) {
    await prisma.airport.createMany({ data: batch, skipDuplicates: true });
  }
}

async function seedAirlinesFromBundle(airlines: BundledAirline[]): Promise<void> {
  // `Airline.iata` is @unique, and migration
  // 20260901120000_airline_icao_partial_unique_index adds a matching
  // partial unique index on `icao` scoped to rows where `iata IS NULL` —
  // together these cover every bundled airline (IATA-bearing or
  // ICAO-only), so a plain skipDuplicates insert is correct and atomic
  // even across multiple concurrent server processes seeding the same
  // brand-new database at once. (An earlier version of this function did
  // its own findMany-then-filter pre-check for the ICAO-only case, since
  // the database itself couldn't dedupe it — safe within one process, but
  // not atomic across several; the partial index closes that gap at the
  // source instead of working around it here. See prisma/seed.ts's
  // seedAirlines() for the identical simplification on the manual-seed
  // path, and prisma/seed-data/parse.ts's parseAirlinesDat() for the
  // matching within-file dedup that keeps the bundled dataset itself
  // free of duplicates in the first place.)
  for (const batch of chunk(airlines, 2000)) {
    await prisma.airline.createMany({ data: batch, skipDuplicates: true });
  }
}

async function seedAircraftFromBundle(aircraft: BundledAircraft[]): Promise<void> {
  for (const batch of chunk(aircraft, 2000)) {
    await prisma.aircraftType.createMany({ data: batch, skipDuplicates: true });
  }
}

export type AirportOption = {
  id: number;
  iata: string;
  name: string;
  city: string;
  country: string;
  /** IANA timezone identifier (e.g. "America/Chicago"), backfilled from the
   * airport's lat/long — see prisma/seed.ts and scripts/backfill-airport-timezones.ts.
   * Null for an airport that predates the backfill or has no coordinates;
   * callers computing flight duration must handle that gracefully (see
   * src/lib/flight-duration.ts). */
  timezone: string | null;
};

export async function searchAirports(query: string): Promise<AirportOption[]> {
  await ensureReferenceDataSeeded();
  const q = query.trim();
  if (!q) {
    const popular = await prisma.airport.findMany({
      where: { iata: { in: ["JFK", "LAX", "ORD", "LHR", "DXB", "CDG", "SFO", "MIA", "ATL", "DFW"] } },
      select: { id: true, iata: true, name: true, city: true, country: true, timezone: true },
    });
    return popular;
  }

  const TOTAL_LIMIT = 20;

  // IATA matches (exact, then prefix) are fetched in their own query first
  // so they can never be crowded out by `take` — a combined OR query
  // ordered by iata and truncated to 20 rows can silently drop the actual
  // "HOU" row for a "HOU" search if 20+ city/name/country matches happen
  // to sort before it alphabetically.
  const iataMatches = await prisma.airport.findMany({
    where: { iata: { startsWith: q, mode: "insensitive" } },
    select: { id: true, iata: true, name: true, city: true, country: true, timezone: true },
    take: TOTAL_LIMIT,
    orderBy: [{ iata: "asc" }],
  });
  iataMatches.sort((a, b) => {
    const aExact = a.iata.toLowerCase() === q.toLowerCase() ? 0 : 1;
    const bExact = b.iata.toLowerCase() === q.toLowerCase() ? 0 : 1;
    return aExact - bExact;
  });

  const remaining = TOTAL_LIMIT - iataMatches.length;
  if (remaining <= 0) return iataMatches;

  const broaderMatches = await prisma.airport.findMany({
    where: {
      id: { notIn: iataMatches.map((a) => a.id) },
      OR: [
        { city: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { country: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { id: true, iata: true, name: true, city: true, country: true, timezone: true },
    take: remaining,
    orderBy: [{ iata: "asc" }],
  });

  return [...iataMatches, ...broaderMatches];
}

export type AirlineOption = {
  id: number;
  iata: string | null;
  icao: string | null;
  name: string;
  logoUrl: string | null;
};

export async function searchAirlines(query: string): Promise<AirlineOption[]> {
  await ensureReferenceDataSeeded();
  const q = query.trim();
  if (!q) {
    const popular = await prisma.airline.findMany({
      where: { isActive: true, iata: { not: null } },
      select: { id: true, iata: true, icao: true, name: true, logoUrl: true },
      orderBy: { name: "asc" },
      take: 10,
    });
    return popular;
  }

  const results = await prisma.airline.findMany({
    where: {
      isActive: true,
      OR: [
        { iata: { equals: q, mode: "insensitive" } },
        { icao: { equals: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { id: true, iata: true, icao: true, name: true, logoUrl: true },
    take: 20,
  });

  return results.sort((a, b) => {
    const aExact = a.iata?.toLowerCase() === q.toLowerCase() || a.icao?.toLowerCase() === q.toLowerCase() ? 0 : 1;
    const bExact = b.iata?.toLowerCase() === q.toLowerCase() || b.icao?.toLowerCase() === q.toLowerCase() ? 0 : 1;
    return aExact - bExact;
  });
}

export type AircraftOption = {
  id: number;
  code: string | null;
  displayName: string;
  manufacturer: string;
};

export async function searchAircraft(query: string): Promise<AircraftOption[]> {
  await ensureReferenceDataSeeded();
  const q = query.trim();
  if (!q) {
    const popular = await prisma.aircraftType.findMany({
      select: { id: true, code: true, displayName: true, manufacturer: true },
      orderBy: { displayName: "asc" },
      take: 10,
    });
    return popular;
  }

  const results = await prisma.aircraftType.findMany({
    where: {
      OR: [
        { code: { equals: q, mode: "insensitive" } },
        { displayName: { contains: q, mode: "insensitive" } },
        { manufacturer: { contains: q, mode: "insensitive" } },
      ],
    },
    select: { id: true, code: true, displayName: true, manufacturer: true },
    take: 20,
  });

  return results.sort((a, b) => {
    const aExact = a.code?.toLowerCase() === q.toLowerCase() ? 0 : 1;
    const bExact = b.code?.toLowerCase() === q.toLowerCase() ? 0 : 1;
    return aExact - bExact;
  });
}

// Item 17 (edge cases) — bug fix found live: these three functions only
// `.toUpperCase()`'d incoming codes, never `.trim()`'d them (unlike the
// search* functions above, which do), so a code with incidental
// leading/trailing whitespace could never match a real reference row even
// though it clearly should have. Fixed by normalizing (trim + uppercase)
// separately from the map's own keys: the Postgres query always uses the
// normalized form, but the returned Record is keyed by each ORIGINAL,
// un-normalized input string — callers (e.g. itinerary-parse-hydration.ts)
// always look a result up using the exact same raw string they put into
// the `codes` array, so the map's keys must match that, not the
// normalized form used only for the query itself.
function normalizeReferenceCode(code: string): string {
  return code.trim().toUpperCase();
}

export async function resolveAirportCodes(codes: string[]): Promise<Record<string, AirportOption | null>> {
  await ensureReferenceDataSeeded();
  const originals = [...new Set(codes.filter(Boolean))];
  if (originals.length === 0) return {};
  const normalized = [...new Set(originals.map(normalizeReferenceCode))];
  const airports = await prisma.airport.findMany({
    where: { iata: { in: normalized } },
    select: { id: true, iata: true, name: true, city: true, country: true, timezone: true },
  });
  const map: Record<string, AirportOption | null> = {};
  for (const original of originals) {
    const code = normalizeReferenceCode(original);
    map[original] = airports.find((a) => a.iata === code) ?? null;
  }
  return map;
}

/**
 * Pass 18 — airline-logo pipeline audit. IATA/ICAO codes are historically
 * reassigned once a carrier goes defunct (confirmed against this exact
 * database: id 3200 "8z"/LER, Linea Aerea de Servicio Ejecutivo Regional,
 * Venezuela, isActive:false, vs id 5276 "8Z"/WVL, Wizz Air Hungary,
 * isActive:true — a genuine, real, non-error code reuse, not a data-entry
 * mistake). The uppercase-normalized query below already resolves this
 * ONE known case safely by pure case-sensitivity (only the exact-case
 * "8Z" row is ever queried), but the underlying lookup had NO explicit
 * `isActive` preference and NO deterministic ordering at all — `.find()`
 * on an unordered Postgres result set is not guaranteed stable, so if this
 * database ever gains a second genuinely case-matching duplicate (a real,
 * documented possibility for recycled IATA codes), which of the two rows
 * "wins" would be arbitrary — exactly the "the fallback must never
 * accidentally show the logo of another airline" risk this pass was asked
 * to guard against. `orderBy` below makes resolution deterministic: an
 * active carrier's record is always preferred over a defunct one holding
 * the same recycled code, with a stable `id` tiebreak so two genuinely
 * simultaneous actives (a true data error, not the recycling case above)
 * resolve to the same row every time rather than varying by query plan.
 */
export async function resolveAirlineCodes(codes: string[]): Promise<Record<string, AirlineOption | null>> {
  await ensureReferenceDataSeeded();
  const originals = [...new Set(codes.filter(Boolean))];
  if (originals.length === 0) return {};
  const normalized = [...new Set(originals.map(normalizeReferenceCode))];
  const airlines = await prisma.airline.findMany({
    where: { OR: [{ iata: { in: normalized } }, { icao: { in: normalized } }] },
    select: { id: true, iata: true, icao: true, name: true, logoUrl: true, isActive: true },
    orderBy: [{ isActive: "desc" }, { id: "asc" }],
  });
  const map: Record<string, AirlineOption | null> = {};
  for (const original of originals) {
    const code = normalizeReferenceCode(original);
    const match = airlines.find((a) => a.iata === code || a.icao === code) ?? null;
    map[original] = match ? { id: match.id, iata: match.iata, icao: match.icao, name: match.name, logoUrl: match.logoUrl } : null;
  }
  return map;
}

export async function resolveAircraftCodes(codes: string[]): Promise<Record<string, AircraftOption | null>> {
  await ensureReferenceDataSeeded();
  const originals = [...new Set(codes.filter(Boolean))];
  if (originals.length === 0) return {};
  const normalized = [...new Set(originals.map(normalizeReferenceCode))];
  const aircraft = await prisma.aircraftType.findMany({
    where: { code: { in: normalized } },
    select: { id: true, code: true, displayName: true, manufacturer: true },
  });
  const map: Record<string, AircraftOption | null> = {};
  for (const original of originals) {
    const code = normalizeReferenceCode(original);
    map[original] = aircraft.find((a) => a.code === code) ?? null;
  }
  return map;
}

/** Every active account in the caller's own company EXCEPT
 * TICKETING_AGENT/FLIGHT_EXPERT/MARKETING_AGENT — the roles explicitly
 * excluded from the lead/contact-ownership workflow (see
 * src/components/layout/sidebar.tsx's LEAD_WORKFLOW_ROLES and
 * src/server/actions/lead-queue.ts). Feeds the New Lead dialog's Assigned
 * Agent select, lead reassignment, and contact reassignment's New Owner
 * select. Always scoped by companyId (see the Company model's comment in
 * schema.prisma) — an agent must never see or assign work to another
 * company's staff. */
export async function listLeadEligibleAgents(companyId: string) {
  return prisma.account.findMany({
    where: { status: "ACTIVE", companyId, role: { notIn: ["TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] } },
    orderBy: { fullName: "asc" },
    // email is additive — existing callers (New Lead dialog, Contact
    // reassignment) simply don't read it; Bulk Contacts' Assigned User
    // paste-matching (src/lib/bulk-contact-paste.ts's matchAssignedUser)
    // is the one new consumer that needs it, to match by exact email as
    // well as exact name.
    select: { id: true, fullName: true, email: true, role: true },
  });
}

/** Every active account in the caller's own company EXCEPT
 * MARKETING_AGENT — that role has no access to Tasks at all (see
 * canViewTasks in src/lib/permissions.ts), so assigning them one would be
 * a dead-end: the assignee could never see or complete it. Feeds the
 * New/Edit Task dialog's Assignee select. Ticketing Agent/Flight Expert
 * are deliberately left in this list — task assignment for those two
 * roles is pre-existing behavior, unrelated to this fix. */
export async function listTaskEligibleAgents(companyId: string) {
  return prisma.account.findMany({
    where: { status: "ACTIVE", companyId, role: { not: "MARKETING_AGENT" } },
    orderBy: { fullName: "asc" },
    select: { id: true, fullName: true, role: true },
  });
}
