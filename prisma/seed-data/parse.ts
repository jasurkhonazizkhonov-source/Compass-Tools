// Shared parsing/filtering logic for the aviation reference-data files in
// this directory — extracted out of prisma/seed.ts so there is exactly ONE
// implementation of "what counts as a useful row" from these open datasets
// (OurAirports airports.csv, OpenFlights airlines.dat/planes.dat). Used by
// both prisma/seed.ts (the manual `db:seed`/`db:seed:reference-data` CLI
// path) and prisma/seed-data/generate-json.ts (the one-off script that
// produces the committed src/data/reference/*.json files the running app
// reads from — see reference-data.ts's ensureReferenceDataSeeded()). No
// fabricated codes/names: rows are skipped if the source data is missing
// the fields we need — never invented.
import fs from "node:fs";
import path from "node:path";
import tzlookup from "tz-lookup";

export type ParsedAirport = {
  iata: string;
  icao: string | null;
  name: string;
  city: string;
  country: string;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
};

export type ParsedAirline = {
  iata: string | null;
  icao: string | null;
  name: string;
  country: string | null;
  isActive: boolean;
};

export type ParsedAircraft = {
  code: string | null;
  manufacturer: string;
  model: string;
  displayName: string;
};

/** IANA timezone from lat/long — see src/lib/flight-duration.ts for why
 * this is needed (timezone-aware flight duration calculation). tz-lookup
 * throws for out-of-range/invalid coordinates rather than returning null,
 * so this normalizes that to null instead of failing the whole parse run
 * over one bad row. */
function timezoneFromCoords(latitude: number | null, longitude: number | null): string | null {
  if (latitude == null || longitude == null) return null;
  try {
    return tzlookup(latitude, longitude);
  } catch {
    return null;
  }
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(isoCode: string): string {
  try {
    const name = regionNames.of(isoCode);
    return name && name !== isoCode ? name : isoCode;
  } catch {
    return isoCode;
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Resolves a seed-data file's absolute path relative to this directory,
 * so callers (a `tsx prisma/seed.ts` run, or a `tsx prisma/seed-data/
 * generate-json.ts` run) work the same regardless of the caller's own cwd. */
function seedDataPath(fileName: string): string {
  return path.join(__dirname, fileName);
}

export function parseAirportsCsv(): ParsedAirport[] {
  const raw = fs.readFileSync(seedDataPath("airports.csv"), "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const cols = parseCsvLine(lines[0]);
  const idx = (n: string) => cols.indexOf(n);
  const iataI = idx("iata_code");
  const icaoI = idx("icao_code");
  const nameI = idx("name");
  const cityI = idx("municipality");
  const countryI = idx("iso_country");
  const latI = idx("latitude_deg");
  const lonI = idx("longitude_deg");

  const rows: ParsedAirport[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const iata = f[iataI]?.trim();
    if (!iata || seen.has(iata)) continue;
    seen.add(iata);
    const isoCountry = f[countryI]?.trim() || null;
    const latitude = f[latI] ? Number(f[latI]) : null;
    const longitude = f[lonI] ? Number(f[lonI]) : null;
    rows.push({
      iata,
      icao: f[icaoI]?.trim() || null,
      name: f[nameI]?.trim() || iata,
      city: f[cityI]?.trim() || "",
      country: isoCountry ? countryName(isoCountry) : "Unknown",
      countryCode: isoCountry,
      latitude,
      longitude,
      timezone: timezoneFromCoords(latitude, longitude),
    });
  }
  return rows;
}

export function parseAirlinesDat(): ParsedAirline[] {
  const raw = fs.readFileSync(seedDataPath("airlines.dat"), "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const rows: ParsedAirline[] = [];
  const seenIata = new Set<string>();
  // Bug fix — `Airline.iata` is the only `@unique` column on this model
  // (`icao` has no DB-level uniqueness constraint), so a row with no IATA
  // code was never deduped by createMany's skipDuplicates at all: standard
  // SQL treats every NULL as distinct from every other NULL, so re-running
  // the seed repeatedly kept inserting a fresh full copy of every
  // no-IATA/ICAO-only airline every time (confirmed live: ~13,878 rows
  // accumulated in the shared dev DB from repeated runs before this fix,
  // cleaned up separately). Deduping by icao here as well — in addition to
  // the DB unique constraint on iata — means a single parse pass can never
  // produce two rows with the same icao, and the insert-time dedup in
  // reference-data.ts's ensureReferenceDataSeeded() additionally checks
  // existing icao values before inserting, so this can't recur across runs.
  const seenIcao = new Set<string>();
  for (const line of lines) {
    const f = parseCsvLine(line);
    // id, name, alias, iata, icao, callsign, country, active
    const name = f[1]?.trim();
    const iataRaw = f[3]?.trim();
    const icaoRaw = f[4]?.trim();
    const countryRaw = f[6]?.trim();
    const activeRaw = f[7]?.trim();

    if (!name || name === "-" || name === "Unknown" || name === "Private flight") continue;
    const iata = iataRaw && iataRaw !== "\\N" && iataRaw !== "" ? iataRaw : null;
    const icao = icaoRaw && icaoRaw !== "\\N" && icaoRaw !== "" ? icaoRaw : null;
    if (!iata && !icao) continue;
    if (iata) {
      if (seenIata.has(iata)) continue;
      seenIata.add(iata);
    } else if (icao) {
      // Only rows with no IATA rely on icao for de-duplication — an IATA
      // match already fully identifies the airline regardless of icao.
      if (seenIcao.has(icao)) continue;
      seenIcao.add(icao);
    }

    rows.push({
      iata,
      icao,
      name,
      country: countryRaw && countryRaw !== "\\N" && countryRaw !== "" ? countryRaw : null,
      isActive: activeRaw === "Y",
    });
  }
  return rows;
}

export function parseAircraftDat(): ParsedAircraft[] {
  const raw = fs.readFileSync(seedDataPath("planes.dat"), "utf-8");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const rows: ParsedAircraft[] = [];
  const seenCode = new Set<string>();
  for (const line of lines) {
    const f = parseCsvLine(line);
    // name, iata, icao
    const name = f[0]?.trim();
    const iata = f[1]?.trim();
    const icao = f[2]?.trim();
    if (!name) continue;
    const code = iata && iata !== "\\N" && iata !== "" ? iata : icao && icao !== "\\N" && icao !== "" ? icao : null;
    if (code) {
      if (seenCode.has(code)) continue;
      seenCode.add(code);
    }
    const parts = name.split(" ");
    const manufacturer = parts[0] || name;
    const model = parts.slice(1).join(" ") || name;

    rows.push({ code, manufacturer, model, displayName: name });
  }
  return rows;
}
