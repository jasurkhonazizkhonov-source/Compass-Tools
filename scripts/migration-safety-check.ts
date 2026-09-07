// Read-only diagnostic for Scenario B (moving an existing company's CRM
// data to a different PostgreSQL database/instance) — see the "Two
// different 'new database' scenarios" section of prisma/seed-data/
// README.md for the full explanation of why this exists.
//
// This tool NEVER writes to the database, and it does not perform any
// migration itself. It answers one narrow, safety-critical question: "if
// I restore this company's business data (Leads, Quotes, historical
// FlightSegment rows, etc.) into a database whose Airport/Airline/
// AircraftType tables were populated independently (self-healed from the
// bundled JSON, or restored separately), do the numeric ids those
// historical rows reference still point at the SAME airport/airline/
// aircraft they originally meant?"
//
// It cannot be answered automatically without a "before" reference point,
// because the self-healing mechanism deliberately never remembers what a
// PREVIOUS database's ids were — there's nothing to compare against unless
// you took a snapshot first. Hence two modes:
//
//   npx tsx scripts/migration-safety-check.ts --snapshot before.json
//     Run this against the SOURCE database, BEFORE starting a migration.
//     Records the current id -> code mapping for Airport/Airline/
//     AircraftType, plus a count of historical FlightSegment rows.
//
//   npx tsx scripts/migration-safety-check.ts --verify before.json
//     Run this against the DESTINATION database, AFTER migrating/
//     restoring, before trusting it with real traffic. Reports any id
//     whose code no longer matches the snapshot (a genuine FK-integrity
//     risk for historical FlightSegment rows) or any id missing entirely.
//
//   npx tsx scripts/migration-safety-check.ts
//     No flags — just reports the current database's state (row counts,
//     whether historical business data exists) as a quick sanity check.
//
// Every mode also runs a direct dangling-foreign-key check (does every
// FlightSegment row's departureAirportId/arrivalAirportId/airlineId/
// aircraftTypeId actually resolve to a row that exists right now?) —
// under normal operation Postgres's own FK constraints make this
// impossible, so a failure here is a strong, immediate signal that a
// restore bypassed constraint checking or was interrupted partway
// through, independent of having a snapshot to compare against at all.
//
// This intentionally does NOT attempt automatic FK remapping. A tool that
// silently "fixes" ids by guessing could easily make a wrong flight
// segment look right instead of visibly broken — see this file's own
// report output for what to do when a mismatch is found.
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import airportsData from "../src/data/reference/airports.json";
import airlinesData from "../src/data/reference/airlines.json";
import aircraftData from "../src/data/reference/aircraft.json";

function connectionStringWithoutSslMode(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  return u.toString();
}

const adapter = new PrismaPg({
  connectionString: connectionStringWithoutSslMode(process.env.DATABASE_URL!),
  ssl: { rejectUnauthorized: false },
});
const prisma = new PrismaClient({ adapter });

type Snapshot = {
  takenAt: string;
  flightSegmentCount: number;
  /** Leads with at least one airport FK set — a separate historical
   * relationship from FlightSegment's (see checkDanglingForeignKeys's own
   * comment for why both matter). */
  leadWithAirportCount: number;
  airports: Record<number, string>; // id -> iata
  airlines: Record<number, string>; // id -> iata|icao (iata preferred)
  aircraft: Record<number, string>; // id -> code
};

async function buildSnapshot(): Promise<Snapshot> {
  const [flightSegmentCount, leadWithAirportCount, airports, airlines, aircraft] = await Promise.all([
    prisma.flightSegment.count(),
    prisma.lead.count({ where: { OR: [{ departureAirportId: { not: null } }, { arrivalAirportId: { not: null } }] } }),
    prisma.airport.findMany({ select: { id: true, iata: true } }),
    prisma.airline.findMany({ select: { id: true, iata: true, icao: true } }),
    prisma.aircraftType.findMany({ select: { id: true, code: true } }),
  ]);
  return {
    takenAt: new Date().toISOString(),
    flightSegmentCount,
    leadWithAirportCount,
    airports: Object.fromEntries(airports.map((a) => [a.id, a.iata])),
    airlines: Object.fromEntries(airlines.map((a) => [a.id, a.iata ?? a.icao ?? ""])),
    aircraft: Object.fromEntries(aircraft.filter((a) => a.code).map((a) => [a.id, a.code as string])),
  };
}

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

/**
 * Direct integrity check, independent of any snapshot: are there any
 * FlightSegment or Lead rows RIGHT NOW whose airport/airline/aircraft
 * foreign keys don't resolve to an existing row? `FlightSegment` isn't
 * the only model with a historical relationship into the reference
 * tables — `Lead.departureAirportId`/`arrivalAirportId` are the same
 * shape of nullable FK into `Airport`, populated by the public
 * lead-capture form and the CRM's own Lead-creation flow, and carry the
 * identical "wrong id after an independent reference-table rebuild" risk.
 * (`Lead.preferredAirline` and `Passenger.frequentFlyerAirline` are plain
 * free-text fields, not foreign keys — nothing to check there.)
 *
 * Under normal operation Postgres's own FK constraints make a dangling
 * reference impossible — but a bulk restore that disabled/deferred
 * constraint checking (a common pg_restore option) or a partial/
 * interrupted restore could leave exactly this behind, and it's cheap
 * enough to check directly rather than only inferring it from a
 * before/after snapshot comparison. This is the "more explicit detection
 * of a partial/restored database" this tool didn't originally have.
 */
async function checkDanglingForeignKeys(): Promise<string[]> {
  const rows: Array<{ issue: string; count: bigint }> = await prisma.$queryRaw`
    SELECT 'FlightSegment.departureAirportId' AS issue, COUNT(*) AS count FROM "FlightSegment" fs
      LEFT JOIN "Airport" a ON a.id = fs."departureAirportId" WHERE a.id IS NULL
    UNION ALL
    SELECT 'FlightSegment.arrivalAirportId', COUNT(*) FROM "FlightSegment" fs
      LEFT JOIN "Airport" a ON a.id = fs."arrivalAirportId" WHERE a.id IS NULL
    UNION ALL
    SELECT 'FlightSegment.airlineId', COUNT(*) FROM "FlightSegment" fs
      LEFT JOIN "Airline" al ON al.id = fs."airlineId" WHERE fs."airlineId" IS NOT NULL AND al.id IS NULL
    UNION ALL
    SELECT 'FlightSegment.aircraftTypeId', COUNT(*) FROM "FlightSegment" fs
      LEFT JOIN "AircraftType" ac ON ac.id = fs."aircraftTypeId" WHERE fs."aircraftTypeId" IS NOT NULL AND ac.id IS NULL
    UNION ALL
    SELECT 'Lead.departureAirportId', COUNT(*) FROM "Lead" l
      LEFT JOIN "Airport" a ON a.id = l."departureAirportId" WHERE l."departureAirportId" IS NOT NULL AND a.id IS NULL
    UNION ALL
    SELECT 'Lead.arrivalAirportId', COUNT(*) FROM "Lead" l
      LEFT JOIN "Airport" a ON a.id = l."arrivalAirportId" WHERE l."arrivalAirportId" IS NOT NULL AND a.id IS NULL
  `;
  return rows
    .filter((r) => Number(r.count) > 0)
    .map((r) => `${Number(r.count)} row(s) have a "${r.issue}" that does not resolve to any existing row — dangling foreign key`);
}

async function reportCurrentState() {
  const flightSegmentCount = await prisma.flightSegment.count();
  const leadWithAirportCount = await prisma.lead.count({ where: { OR: [{ departureAirportId: { not: null } }, { arrivalAirportId: { not: null } }] } });
  const [airportCount, airlineCount, aircraftCount] = await Promise.all([
    prisma.airport.count(),
    prisma.airline.count(),
    prisma.aircraftType.count(),
  ]);
  console.log(`Historical FlightSegment rows: ${flightSegmentCount}`);
  console.log(`Leads with an airport reference: ${leadWithAirportCount}`);
  console.log(`Airport rows: ${airportCount} (bundled dataset has ${airportsData.length})`);
  console.log(`Airline rows: ${airlineCount} (bundled dataset has ${airlinesData.length})`);
  console.log(`AircraftType rows: ${aircraftCount} (bundled dataset has ${aircraftData.length})`);

  const dangling = await checkDanglingForeignKeys();
  if (dangling.length > 0) {
    console.log("\nFAIL — dangling foreign keys found (this should be impossible under normal operation");
    console.log("and strongly suggests a partial or constraint-bypassing restore happened):\n");
    for (const d of dangling) console.log(`  - ${d}`);
    process.exitCode = 1;
    return;
  }

  const historicalRowCount = flightSegmentCount + leadWithAirportCount;
  if (historicalRowCount === 0) {
    console.log("\nNo historical FlightSegment or Lead-with-airport rows exist — this looks like a fresh");
    console.log("installation (Scenario A). The self-healing reference-data mechanism is fully sufficient");
    console.log("here; no migration safety concern applies.");
  } else {
    console.log(`\n${flightSegmentCount} historical FlightSegment row(s) and ${leadWithAirportCount} Lead row(s)`);
    console.log("with an airport reference exist, and all of them resolve to an existing airport/airline/");
    console.log("aircraft row right now (no dangling foreign keys). That does NOT by itself prove the ids");
    console.log("point at the CORRECT airport/airline/aircraft, though — only that they point at");
    console.log("*something*. If this database's Airport/Airline/AircraftType tables were ever");
    console.log("independently recreated (dropped and re-seeded, or restored separately from the business");
    console.log("data) rather than restored together with the business data in one atomic pg_dump/");
    console.log("pg_restore, take a --snapshot before any such operation and --verify it after, to");
    console.log("confirm historical ids still resolve to the same airport/airline/aircraft they");
    console.log("originally meant.");
  }
}

async function main() {
  const snapshotPath = readArg("snapshot");
  const verifyPath = readArg("verify");

  if (snapshotPath) {
    const snapshot = await buildSnapshot();
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    console.log(`Snapshot written to ${snapshotPath}`);
    console.log(`  ${snapshot.flightSegmentCount} historical FlightSegment row(s), ${snapshot.leadWithAirportCount} Lead row(s) with an airport reference`);
    console.log(`  ${Object.keys(snapshot.airports).length} airports, ${Object.keys(snapshot.airlines).length} airlines, ${Object.keys(snapshot.aircraft).length} aircraft`);
    console.log("\nRun this again with --verify <this file> against the DESTINATION database after migrating.");
    return;
  }

  if (verifyPath) {
    const before: Snapshot = JSON.parse(readFileSync(verifyPath, "utf-8"));
    const after = await buildSnapshot();

    const mismatches: string[] = [];
    for (const [table, beforeMap, afterMap] of [
      ["Airport", before.airports, after.airports],
      ["Airline", before.airlines, after.airlines],
      ["AircraftType", before.aircraft, after.aircraft],
    ] as const) {
      for (const [id, beforeCode] of Object.entries(beforeMap)) {
        const afterCode = afterMap[Number(id)];
        if (afterCode === undefined) {
          mismatches.push(`${table} id ${id} (was "${beforeCode}") no longer exists in this database`);
        } else if (afterCode !== beforeCode) {
          mismatches.push(`${table} id ${id} was "${beforeCode}" in the snapshot, but is now "${afterCode}" — a historical FlightSegment or Lead row referencing this id would now point at the WRONG ${table.toLowerCase()}`);
        }
      }
    }

    console.log(`Snapshot taken: ${before.takenAt} (${before.flightSegmentCount} historical FlightSegment rows, ${before.leadWithAirportCount} Lead rows with an airport reference, at that time)`);
    console.log(`Current database: ${after.flightSegmentCount} historical FlightSegment rows, ${after.leadWithAirportCount} Lead rows with an airport reference, now`);

    const dangling = await checkDanglingForeignKeys();
    for (const d of dangling) mismatches.push(d);

    if (mismatches.length === 0) {
      console.log("\nPASS — every airport/airline/aircraft id in the snapshot still maps to the same code.");
      console.log("It is safe to trust historical FlightSegment and Lead rows' airport/airline/aircraft");
      console.log("foreign keys.");
      process.exit(0);
    } else {
      console.log(`\nFAIL — ${mismatches.length} id mismatch(es) found:\n`);
      for (const m of mismatches.slice(0, 50)) console.log(`  - ${m}`);
      if (mismatches.length > 50) console.log(`  ... and ${mismatches.length - 50} more`);
      console.log("\nDo NOT trust historical FlightSegment or Lead rows' airport/airline/aircraft foreign");
      console.log("keys in this database. Restore Airport/Airline/AircraftType from the SAME backup as the");
      console.log("business data (a full pg_dump/pg_restore), rather than relying on the self-healing");
      console.log("mechanism, which only guarantees CODE resolution (IATA/ICAO -> the right row) for new");
      console.log("lookups going forward — it makes no promise about matching a specific PREVIOUS");
      console.log("database's numeric ids.");
      process.exit(1);
    }
  }

  await reportCurrentState();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
