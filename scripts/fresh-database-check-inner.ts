// Runs INSIDE a child process whose own DATABASE_URL environment variable
// (set by fresh-database-check.ts, never written to any file) already
// points at a freshly migrated, otherwise-empty database — zero manually
// seeded Airport/Airline/AircraftType rows. Everything below goes through
// the exact same application code every real request uses (@/lib/prisma's
// singleton, @/server/queries/reference-data.ts, the real GDS parsers) —
// this is not a reimplementation of the self-healing logic, it's a
// scripted repetition of the manual "connect a genuinely fresh Postgres
// database and use the app normally" test procedure. Prints one JSON
// object to stdout and exits 0 on success, 1 with a message on failure.
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { searchAirports, resolveAirportCodes, resolveAirlineCodes, resolveAircraftCodes } from "../src/server/queries/reference-data";
import { parseSabreItinerary } from "../src/lib/parsers/sabre";
import { parseApolloItinerary } from "../src/lib/parsers/apollo";
import { hydrateParsedSegments } from "../src/lib/itinerary-parse-hydration";
import { resolveAirlineDisplay } from "../src/lib/canonical-segment";
import airportsData from "../src/data/reference/airports.json";
import airlinesData from "../src/data/reference/airlines.json";
import aircraftData from "../src/data/reference/aircraft.json";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function main() {
  const results: Record<string, unknown> = {};

  // 1. Airport search + stable-code resolution work with zero manual seeding.
  const searchResults = await searchAirports("JFK");
  assert(searchResults.some((a) => a.iata === "JFK"), "searchAirports('JFK') should find JFK on a fresh database");
  const airportMap = await resolveAirportCodes(["JFK", "LAX", "LHR"]);
  assert(airportMap["JFK"]?.iata === "JFK", "resolveAirportCodes should resolve JFK");
  assert(airportMap["LAX"]?.city === "Los Angeles", "resolveAirportCodes should resolve LAX with correct city");
  assert(airportMap["LHR"]?.iata === "LHR", "resolveAirportCodes should resolve LHR");
  results.airportResolution = "ok";

  // 2. Airline resolution.
  const airlineMap = await resolveAirlineCodes(["LH", "EK"]);
  assert(airlineMap["LH"]?.name.match(/Lufthansa/i), "resolveAirlineCodes should resolve LH to Lufthansa");
  assert(airlineMap["EK"]?.name.match(/Emirates/i), "resolveAirlineCodes should resolve EK to Emirates");
  results.airlineResolution = "ok";

  // 3. Aircraft resolution.
  const aircraftMap = await resolveAircraftCodes(["738", "320"]);
  assert(aircraftMap["738"] !== null, "resolveAircraftCodes should resolve 738 (Boeing 737-800)");
  results.aircraftResolution = "ok";

  // 4. A representative Sabre itinerary parses and hydrates end to end —
  // real parser, real hydration, real (fresh) reference data underneath.
  // Sabre and SWAN are the exact same code path (parseSabreItinerary is a
  // direct passthrough to the shared GDS parser — see sabre.ts's own doc
  // comment), so this covers both; there is no separate SWAN parser to
  // exercise.
  const parsedSabre = parseSabreItinerary("1 LH400C 12MAR FRA-JFK HK1 1050A 130P TH", 2026);
  assert(parsedSabre.length === 1, "Sabre parser should produce exactly one segment");
  const [hydratedSabre] = await hydrateParsedSegments(parsedSabre, "ECONOMY");
  assert(hydratedSabre.departureAirport?.iata === "FRA", "hydrated Sabre segment should resolve FRA");
  assert(hydratedSabre.arrivalAirport?.iata === "JFK", "hydrated Sabre segment should resolve JFK");
  assert(hydratedSabre.airline?.name.match(/Lufthansa/i), "hydrated Sabre segment should resolve Lufthansa");
  results.sabreParseAndHydration = "ok";

  // 4b. Apollo, independently — a different route/airline so this can't
  // pass merely because the reference data was already warmed by the
  // Sabre check above.
  const parsedApollo = parseApolloItinerary("1 CX255Y 04SEP FCOMNL SS1 600P 725P * FR E", 2026);
  assert(parsedApollo.length === 1, "Apollo parser should produce exactly one segment");
  const [hydratedApollo] = await hydrateParsedSegments(parsedApollo, "ECONOMY");
  assert(hydratedApollo.departureAirport?.iata === "FCO", "hydrated Apollo segment should resolve FCO");
  assert(hydratedApollo.arrivalAirport?.iata === "MNL", "hydrated Apollo segment should resolve MNL");
  assert(hydratedApollo.airline?.name.match(/Cathay Pacific/i), "hydrated Apollo segment should resolve Cathay Pacific");
  results.apolloParseAndHydration = "ok";

  // 4c. Airline logo — the exact live-browser-verified scenario, now
  // automated: on a fresh database every self-healed Airline.logoUrl is
  // null, so the CDN-URL fallback (not a stored database value) is what
  // every itinerary-display/email/customer-facing surface actually
  // renders. Confirms canonical-segment.ts's resolveAirlineDisplay — the
  // one function every real rendering surface goes through — produces a
  // real logo URL here, not null.
  assert(hydratedApollo.airline?.logoUrl === null, "a freshly self-healed Airline row should have a null logoUrl (nothing curates it)");
  const resolvedDisplay = resolveAirlineDisplay(hydratedApollo.airline, parsedApollo[0].airlineCode ?? null);
  assert(resolvedDisplay.logoUrl === "https://images.kiwi.com/airlines/64x64/CX.png", `airline logo should fall back to the CDN URL, got: ${resolvedDisplay.logoUrl}`);
  results.airlineLogoFallback = "ok";

  // 5. Idempotency (Test B) — a second round of lookups must not create
  // duplicate rows. Compare raw counts before/after a fresh set of calls,
  // AND compare against the actual bundled dataset size (never a
  // hardcoded number — a legitimate future update to airports.json/
  // airlines.json/aircraft.json must not make this check start failing).
  const countsBefore = {
    airports: await prisma.airport.count(),
    airlines: await prisma.airline.count(),
    aircraft: await prisma.aircraftType.count(),
  };
  assert(countsBefore.airports === airportsData.length, `airport table (${countsBefore.airports}) should match the bundled dataset (${airportsData.length}) after self-healing from empty`);
  assert(countsBefore.airlines === airlinesData.length, `airline table (${countsBefore.airlines}) should match the bundled dataset (${airlinesData.length}) after self-healing from empty`);
  assert(countsBefore.aircraft === aircraftData.length, `aircraft table (${countsBefore.aircraft}) should match the bundled dataset (${aircraftData.length}) after self-healing from empty`);
  await Promise.all([searchAirports("LAX"), resolveAirlineCodes(["BA", "AF"]), resolveAircraftCodes(["77W"])]);
  const countsAfter = {
    airports: await prisma.airport.count(),
    airlines: await prisma.airline.count(),
    aircraft: await prisma.aircraftType.count(),
  };
  assert(countsBefore.airports === countsAfter.airports, `airport count changed on repeated init: ${countsBefore.airports} -> ${countsAfter.airports}`);
  assert(countsBefore.airlines === countsAfter.airlines, `airline count changed on repeated init: ${countsBefore.airlines} -> ${countsAfter.airlines}`);
  assert(countsBefore.aircraft === countsAfter.aircraft, `aircraft count changed on repeated init: ${countsBefore.aircraft} -> ${countsAfter.aircraft}`);
  results.idempotency = "ok";
  results.finalCounts = countsAfter;

  // 6. Concurrent-insert duplicate prevention (Item 8), against a
  // genuinely fresh database this time rather than the already-seeded dev
  // database reference-data.test.ts's equivalent test uses — proves the
  // partial unique index (migration 20260901120000) protects an
  // ICAO-only airline insert race from the very first moments of a new
  // database's life, not just once it's already fully populated.
  const testIcao = "ZZFRESHDBTEST";
  const [insertA, insertB] = await Promise.all([
    prisma.airline.createMany({ data: [{ iata: null, icao: testIcao, name: "Fresh DB Concurrency Test", country: null, logoUrl: null, isActive: true }], skipDuplicates: true }),
    prisma.airline.createMany({ data: [{ iata: null, icao: testIcao, name: "Fresh DB Concurrency Test", country: null, logoUrl: null, isActive: true }], skipDuplicates: true }),
  ]);
  assert(insertA.count + insertB.count === 1, `expected exactly one of two concurrent icao-only inserts to succeed, got ${insertA.count + insertB.count}`);
  const dupeRows = await prisma.airline.findMany({ where: { icao: testIcao, iata: null } });
  assert(dupeRows.length === 1, `expected exactly one row for the concurrently-inserted icao, found ${dupeRows.length}`);
  await prisma.airline.deleteMany({ where: { icao: testIcao, iata: null } });
  results.concurrentInsertDuplicatePrevention = "ok";

  console.log(JSON.stringify({ ok: true, results }));
}

main()
  .catch((err) => {
    console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
