// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// REAL-DATABASE proof of the airline reference data after migration 20261005000100_airline_reference_refresh: the picker
// and the code resolver (itinerary builder, booking airline confirmations, emails) find today's airlines, recycled IATA
// codes point at the right carrier, ceased airlines stay in the table but out of the picker, and nothing is duplicated.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

describe.skipIf(!enabled)("airline reference data — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let ref: typeof import("../reference-data");

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ref = await import("../reference-data");
  });
  afterAll(async () => {
    if (enabled) await prisma.$disconnect();
  });

  const top = async (q: string) => (await ref.searchAirlines(q))[0];

  it("the refresh migration is recorded as applied", async () => {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = '20261005000100_airline_reference_refresh'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].finished_at).not.toBeNull();
  });

  it.each([
    ["PC", "Pegasus Airlines", "PGT"], ["V7", "Volotea", "VOE"], ["SG", "SpiceJet", "SEJ"], ["J9", "Jazeera Airways", "JZR"],
    ["JX", "Starlux Airlines", "SJX"], ["YP", "Air Premia", "APZ"], ["AD", "Azul Brazilian Airlines", "AZU"], ["VB", "Viva Aerobus", "VIV"],
    ["VJ", "VietJet Air", "VJC"], ["XP", "Avelo Airlines", "VXP"], ["4Y", "Discover Airlines", "OCN"], ["JU", "Air Serbia", "ASL"],
    ["AZ", "ITA Airways", "ITY"], ["QP", "Akasa Air", "AKJ"], ["WK", "Edelweiss Air", "EDW"], ["LJ", "Jin Air", "JNA"],
    // not touched by the refresh — must still be right
    ["LH", "Lufthansa", "DLH"], ["EK", "Emirates", "UAE"], ["SQ", "Singapore Airlines", "SIA"], ["QF", "Qantas", "QFA"], ["AA", "American Airlines", "AAL"],
  ])("code %s resolves to %s (ICAO %s), in the itinerary / booking / email resolver", async (iata, name, icao) => {
    const r = (await ref.resolveAirlineCodes([iata]))[iata];
    expect(r).toMatchObject({ iata, name, icao });
    // and by ICAO as well
    expect((await ref.resolveAirlineCodes([icao]))[icao]).toMatchObject({ iata, name });
  });

  it("the picker finds an airline by IATA code, by exact name, by partial name, accent-insensitively — best match first", async () => {
    expect(await top("PC")).toMatchObject({ iata: "PC", name: "Pegasus Airlines" });
    expect(await top("pegasus")).toMatchObject({ iata: "PC" });
    expect(await top("Volotea")).toMatchObject({ iata: "V7" });
    expect(await top("Air Serbia")).toMatchObject({ iata: "JU" });
    expect(await top("aeromexico")).toMatchObject({ iata: "AM" }); // typed without the accent
    expect(await top("air algerie")).toMatchObject({ iata: "AH" });
    expect(await top("jazeera")).toMatchObject({ iata: "J9" });
    expect(await top("ITY")).toMatchObject({ iata: "AZ", name: "ITA Airways" });
  });

  it("an ambiguous fragment returns a ranked list of candidates — it never silently resolves to one airline", async () => {
    const list = await ref.searchAirlines("air");
    expect(list.length).toBeGreaterThan(5);
    expect(new Set(list.map((a) => a.iata ?? a.icao)).size).toBe(list.length); // no duplicate entries
  });

  it("an exact 2-letter code beats longer names that merely contain those letters", async () => {
    for (const code of ["AA", "BA", "QR", "TK", "EK"]) {
      expect((await top(code))?.iata).toBe(code);
    }
  });

  it("airlines that ceased operating are kept but never offered in the picker, and still resolve for historical records", async () => {
    const names = (await ref.searchAirlines("Air Berlin")).map((a) => a.name);
    expect(names).not.toContain("Air Berlin");
    const row = await prisma.airline.findFirst({ where: { name: "Air Berlin" } });
    expect(row).toMatchObject({ iata: "AB", isActive: false });
    expect((await ref.resolveAirlineCodes(["AB"]))["AB"]?.name).toBe("Air Berlin");
  });

  it("the old holder of a recycled code is preserved (inactive, without the code) — nothing was erased", async () => {
    expect(await prisma.airline.findFirst({ where: { name: "Jatayu Airlines" } })).toMatchObject({ iata: null, isActive: false });
    expect(await prisma.airline.findFirst({ where: { name: "Alitalia", icao: "AZA" } })).toMatchObject({ iata: null, isActive: false });
    expect(await prisma.airline.findFirst({ where: { name: "Air Fiji" } })).toMatchObject({ iata: null, isActive: false });
  });

  it("no duplicate IATA codes, no malformed codes, and no code-less airline pair sharing an ICAO", async () => {
    const dupIata = await prisma.$queryRaw<Array<{ iata: string }>>`SELECT iata FROM "Airline" WHERE iata IS NOT NULL GROUP BY iata HAVING count(*) > 1`;
    expect(dupIata).toEqual([]);
    const badIata = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) n FROM "Airline" WHERE iata IS NOT NULL AND iata !~ '^[A-Z0-9]{2}$'`;
    expect(Number(badIata[0].n)).toBe(0);
    const badIcao = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) n FROM "Airline" WHERE icao IS NOT NULL AND icao !~ '^[A-Z]{3}$'`;
    expect(Number(badIcao[0].n)).toBe(0);
    const dupIcao = await prisma.$queryRaw<Array<{ icao: string }>>`SELECT icao FROM "Airline" WHERE iata IS NULL AND icao IS NOT NULL GROUP BY icao HAVING count(*) > 1`;
    expect(dupIcao).toEqual([]);
  });

  it("re-running the migration SQL changes nothing (idempotent)", async () => {
    const sql = fs.readFileSync(path.join(__dirname, "../../../../prisma/migrations/20261005000100_airline_reference_refresh/migration.sql"), "utf-8");
    const snapshot = async () => JSON.stringify(await prisma.$queryRaw`SELECT id, iata, icao, name, "isActive" FROM "Airline" ORDER BY id`);
    const before = await snapshot();
    await prisma.$executeRawUnsafe(sql);
    expect(await snapshot()).toBe(before);
  });
});
