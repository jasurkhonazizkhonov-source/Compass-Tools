import { describe, it, expect, vi, beforeEach } from "vitest";
import airportsData from "@/data/reference/airports.json";
import airlinesData from "@/data/reference/airlines.json";
import aircraftData from "@/data/reference/aircraft.json";

// Database-portability pass — ensureReferenceDataSeeded() is the
// self-healing guard that makes airport/airline/aircraft lookups work
// correctly even against a brand-new, empty PostgreSQL database, by
// bulk-inserting from the bundled src/data/reference/*.json datasets (the
// same filtered data prisma/seed.ts produces from the original CSV/.dat
// files) the first time any reference-data function is called in a given
// server process. This file uses a fully mocked Prisma client (unlike
// reference-data.test.ts, which deliberately hits the real, already-seeded
// dev database to prove real search behavior) so it can freely simulate
// empty/partial/full table states without touching real data.
//
// The guard is memoized at module scope (`let seedPromise`), so each test
// that needs to observe fresh "does it seed or not" behavior resets the
// module via vi.resetModules() + a fresh dynamic import — matching this
// project's established convention for testing singleton/memoized state.

let airportCount: number;
let airlineCount: number;
let aircraftCount: number;
let existingIcaos: Set<string>;
let createManyCalls: Array<{ model: string; count: number }>;
let findManyIcaoCalls: number;

const fakePrisma = {
  airport: {
    count: vi.fn(async () => airportCount),
    createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
      createManyCalls.push({ model: "airport", count: data.length });
      return { count: data.length };
    }),
    findMany: vi.fn(async () => []),
  },
  airline: {
    count: vi.fn(async () => airlineCount),
    createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
      createManyCalls.push({ model: "airline", count: data.length });
      return { count: data.length };
    }),
    // Shared by two different callers with different `where` shapes:
    // ensureReferenceDataSeeded's own icao-existence check (`where: {
    // iata: null, icao: { in: [...] } }`) and searchAirlines's own actual
    // search query (`where: { isActive: true, OR: [...] }`) — only the
    // former is relevant to these tests, so the latter shape is just
    // answered with an empty result.
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const icaoIn = (where as { icao?: { in?: string[] } }).icao?.in;
      if (!icaoIn) return [];
      findManyIcaoCalls += 1;
      return icaoIn.filter((c) => existingIcaos.has(c)).map((icao) => ({ icao }));
    }),
  },
  aircraftType: {
    count: vi.fn(async () => aircraftCount),
    createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
      createManyCalls.push({ model: "aircraftType", count: data.length });
      return { count: data.length };
    }),
    findMany: vi.fn(async () => []),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));

beforeEach(() => {
  airportCount = 0;
  airlineCount = 0;
  aircraftCount = 0;
  existingIcaos = new Set();
  createManyCalls = [];
  findManyIcaoCalls = 0;
  vi.clearAllMocks();
  vi.resetModules();
});

describe("ensureReferenceDataSeeded — empty database self-heals", () => {
  it("bulk-inserts the full bundled dataset for every table when all three are empty", async () => {
    const { searchAirports } = await import("../reference-data");
    await searchAirports("JFK");

    const airportInserted = createManyCalls.filter((c) => c.model === "airport").reduce((n, c) => n + c.count, 0);
    const airlineInserted = createManyCalls.filter((c) => c.model === "airline").reduce((n, c) => n + c.count, 0);
    const aircraftInserted = createManyCalls.filter((c) => c.model === "aircraftType").reduce((n, c) => n + c.count, 0);

    expect(airportInserted).toBe(airportsData.length);
    expect(aircraftInserted).toBe(aircraftData.length);
    // Airline count matches the bundle minus nothing (no pre-existing icaos in this test).
    expect(airlineInserted).toBe(airlinesData.length);
  });

  it("works from any of the six exported functions, not just searchAirports", async () => {
    const { resolveAircraftCodes } = await import("../reference-data");
    await resolveAircraftCodes(["738"]);
    const aircraftInserted = createManyCalls.filter((c) => c.model === "aircraftType").reduce((n, c) => n + c.count, 0);
    expect(aircraftInserted).toBe(aircraftData.length);
  });
});

describe("ensureReferenceDataSeeded — already-seeded database is a fast no-op", () => {
  it("makes zero createMany calls when every table already meets the bundled dataset size", async () => {
    airportCount = airportsData.length;
    airlineCount = airlinesData.length;
    aircraftCount = aircraftData.length;

    const { searchAirlines } = await import("../reference-data");
    await searchAirlines("LH");

    expect(createManyCalls).toHaveLength(0);
  });

  it("is memoized within a process — a second call does not re-check counts", async () => {
    airportCount = airportsData.length;
    airlineCount = airlinesData.length;
    aircraftCount = aircraftData.length;

    const { searchAirports, searchAirlines } = await import("../reference-data");
    await searchAirports("LAX");
    await searchAirlines("BA");

    // count() is called once per model (3 total) across BOTH calls, not
    // once per call (6 total) — proves the seedPromise memoization works.
    expect(fakePrisma.airport.count).toHaveBeenCalledTimes(1);
    expect(fakePrisma.airline.count).toHaveBeenCalledTimes(1);
    expect(fakePrisma.aircraftType.count).toHaveBeenCalledTimes(1);
  });
});

describe("ensureReferenceDataSeeded — partial database only tops up the short table(s)", () => {
  it("only bulk-inserts airlines when airports/aircraft are already full but airlines are short", async () => {
    airportCount = airportsData.length;
    airlineCount = 0;
    aircraftCount = aircraftData.length;

    const { searchAirlines } = await import("../reference-data");
    await searchAirlines("EK");

    expect(createManyCalls.some((c) => c.model === "airport")).toBe(false);
    expect(createManyCalls.some((c) => c.model === "aircraftType")).toBe(false);
    expect(createManyCalls.some((c) => c.model === "airline")).toBe(true);
  });
});

describe("ensureReferenceDataSeeded — airline icao-only duplicate prevention", () => {
  // Historical note: this used to be an app-level pre-check (a findMany
  // querying which icao-only rows already existed, then filtering them out
  // of the insert payload before calling createMany) — safe within a
  // single Node process, but NOT atomic across multiple server processes
  // seeding the same brand-new database at once (two processes could both
  // see "not yet inserted" for the same icao and both try to insert it).
  // Migration 20260901120000_airline_icao_partial_unique_index closed that
  // gap at the database level (a partial unique index on icao, scoped to
  // rows where iata IS NULL), so seedAirlinesFromBundle no longer needs
  // (or performs) its own pre-check — it trusts createMany's
  // skipDuplicates the same way it already does for the iata-bearing
  // rows. See src/server/queries/__tests__/reference-data.test.ts's
  // "Airline icao-only concurrent insert" test for the live proof that the
  // database constraint itself actually prevents the duplicate — this file
  // uses a fully mocked Prisma client, so it can only prove the
  // application no longer does a redundant, non-atomic pre-check.
  it("passes the full airline dataset straight to createMany, with no app-level icao pre-check query", async () => {
    airlineCount = 1; // short of the bundle, triggers a top-up
    const firstNoIataAirline = (airlinesData as Array<{ iata: string | null; icao: string | null }>).find((a) => !a.iata && a.icao);
    if (!firstNoIataAirline?.icao) throw new Error("test fixture assumption failed: expected at least one no-IATA airline in the bundle");
    existingIcaos = new Set([firstNoIataAirline.icao]);

    const { searchAirlines } = await import("../reference-data");
    await searchAirlines("LH");

    expect(findManyIcaoCalls).toBe(0);
    const airlineInserted = createManyCalls.filter((c) => c.model === "airline").reduce((n, c) => n + c.count, 0);
    expect(airlineInserted).toBe(airlinesData.length);
  });

  it("still makes zero insert calls at all once the table already meets the bundle size, icao-only rows included", async () => {
    airlineCount = airlinesData.length; // already full — no insert attempted at all
    airportCount = airportsData.length;
    aircraftCount = aircraftData.length;

    const { searchAirlines } = await import("../reference-data");
    await searchAirlines("BA");

    expect(findManyIcaoCalls).toBe(0);
    expect(createManyCalls.some((c) => c.model === "airline")).toBe(false);
  });
});
