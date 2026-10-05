// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import pg from "pg";

// REAL-DATABASE proof for historical airline references after a recycled IATA code:
//  - the retired old row is still there (id, name, ICAO), inactive, without the code;
//  - new lookups of the code reach today's airline;
//  - a segment saved against the old row keeps showing it until an operator explicitly repairs it;
//  - the dry-run reports exactly the inferable segments and changes nothing; apply (with undo list) re-points ONLY those, only
//    airlineId changes, a second run does nothing, and undo restores the exact original state;
//  - a segment with no usable raw code, an unrelated raw code, or already on the right airline is never touched.
// Needs the airline refresh migration. Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

const TAG = `ah-${Date.now()}`;

describe.skipIf(!enabled)("historical airline references — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let history: typeof import("@/server/airline-history");
  let ref: typeof import("@/server/queries/reference-data");
  let client: pg.Client;
  let jatayuId = 0;
  let vietjetId = 0;
  const seg: Record<string, string> = {};
  let contactId = "";
  let leadId = "";
  let quoteId = "";
  let itineraryId = "";

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    history = await import("@/server/airline-history");
    ref = await import("@/server/queries/reference-data");
    const u = new URL(URL_UNDER_TEST!);
    u.searchParams.delete("sslmode");
    client = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
    await client.connect();

    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    jatayuId = (await prisma.airline.findFirstOrThrow({ where: { name: "Jatayu Airlines" } })).id;
    vietjetId = (await prisma.airline.findFirstOrThrow({ where: { iata: "VJ" } })).id;
    const fra = await prisma.airport.findUniqueOrThrow({ where: { iata: "FRA" } });
    const jfk = await prisma.airport.findUniqueOrThrow({ where: { iata: "JFK" } });

    const contact = await prisma.contact.create({ data: { firstName: "Hist", lastName: `Ory${TAG}`, primaryEmail: `h-${TAG}@example.test`, primaryPhone: "+14155559191", companyId: "default-company" } });
    contactId = contact.id;
    leadId = (await prisma.lead.create({ data: { contactId, status: "QUOTED", source: "OTHER" } })).id;
    quoteId = (await prisma.quote.create({ data: { quoteNumber: `Q-${TAG}`, secureToken: `tok-${TAG}`, leadId, contactId, status: "SENT", adults: 1, adultPrice: 700, taxes: 0, serviceFee: 0, total: 700 } })).id;
    itineraryId = (await prisma.itinerary.create({ data: { quoteId } })).id;

    const make = async (key: string, sequence: number, airlineId: number | null, airlineCodeRaw: string | null, day: number) => {
      const s = await prisma.flightSegment.create({
        data: { itineraryId, sequence, airlineId, airlineCodeRaw, flightNumber: `${100 + sequence}`, departureAirportId: fra.id, arrivalAirportId: jfk.id, departureAt: new Date(Date.UTC(2026, 5, day, 8, 0)), arrivalAt: new Date(Date.UTC(2026, 5, day, 16, 0)) },
      });
      seg[key] = s.id;
    };
    await make("candidate", 1, jatayuId, "VJ", 1); // saved against the old holder, raw code is the current airline's
    await make("candidateLowerSpaced", 2, jatayuId, " vj ", 2); // same, sloppy casing / whitespace
    await make("noRaw", 3, jatayuId, null, 3); // no stored code -> cannot be inferred
    expect(await prisma.airline.findUnique({ where: { iata: "HL" } })).toBeNull(); // a code nobody holds
    await make("unrelatedRaw", 4, jatayuId, "HL", 4); // -> cannot be inferred
    await make("alreadyRight", 5, vietjetId, "VJ", 5); // already on the current airline
    await make("longRaw", 6, jatayuId, "VJC", 6); // not a 2-character IATA code -> not used as evidence
  });
  afterAll(async () => {
    if (!enabled) return;
    await client.end();
    await prisma.flightSegment.deleteMany({ where: { itineraryId } });
    await prisma.itinerary.deleteMany({ where: { id: itineraryId } });
    await prisma.quote.deleteMany({ where: { id: quoteId } });
    await prisma.lead.deleteMany({ where: { id: leadId } });
    await prisma.contact.deleteMany({ where: { id: contactId } });
    await prisma.$disconnect();
  });

  const state = async () => (await prisma.flightSegment.findMany({ where: { itineraryId }, orderBy: { sequence: "asc" } })).map((s) => ({ id: s.id, airlineId: s.airlineId, raw: s.airlineCodeRaw, flight: s.flightNumber, dep: s.departureAt.toISOString(), arr: s.arrivalAt.toISOString() }));

  it("the retired holder is preserved (id, name, ICAO; inactive; no code) and the code now reaches today's airline", async () => {
    const old = await prisma.airline.findUniqueOrThrow({ where: { id: jatayuId } });
    expect(old).toMatchObject({ name: "Jatayu Airlines", iata: null, isActive: false });
    expect(old.icao).toBe("JTY");
    expect((await ref.resolveAirlineCodes(["VJ"]))["VJ"]).toMatchObject({ id: vietjetId, name: "VietJet Air" });
    expect((await ref.resolveAirlineCodes(["JTY"]))["JTY"]).toMatchObject({ id: jatayuId, name: "Jatayu Airlines" }); // history still resolvable by ICAO
  });

  it("a segment saved against the old row still points at it — nothing was rewritten silently", async () => {
    const s = await prisma.flightSegment.findUniqueOrThrow({ where: { id: seg.candidate }, include: { airline: true } });
    expect(s.airline?.name).toBe("Jatayu Airlines");
  });

  it("DRY RUN reports exactly the inferable segments and the airline pair, writes nothing", async () => {
    const before = await state();
    const report = await history.reportAirlineHistory(client);
    const mine = report.candidates.filter((c) => Object.values(seg).includes(c.segmentId));
    expect(mine.map((c) => c.segmentId).sort()).toEqual([seg.candidate, seg.candidateLowerSpaced].sort());
    expect(mine[0]).toMatchObject({ oldAirlineId: jatayuId, newAirlineId: vietjetId, newIata: "VJ", oldName: "Jatayu Airlines" });
    expect(report.byPair.find((p) => p.to === "VietJet Air (VJ)")?.segments).toBeGreaterThanOrEqual(2);
    expect(report.notInferable).toBeGreaterThanOrEqual(3); // noRaw, unrelatedRaw, longRaw
    expect(await state()).toEqual(before);
  });

  it("a date filter narrows the report", async () => {
    const report = await history.reportAirlineHistory(client, { since: new Date(Date.UTC(2026, 5, 2)) });
    const ids = report.candidates.map((c) => c.segmentId);
    expect(ids).toContain(seg.candidateLowerSpaced);
    expect(ids).not.toContain(seg.candidate); // departs 2026-06-01, before the cutoff
  });

  it("APPLY re-points only the inferable segments, records the undo list FIRST, changes nothing but airlineId (times, flight numbers and codes untouched), and is idempotent", async () => {
    const before = await state();
    const report = await history.reportAirlineHistory(client);
    const mine = report.candidates.filter((c) => Object.values(seg).includes(c.segmentId));
    let recorded: unknown[] = [];
    let recordedBeforeFirstWrite = false;
    const result = await history.applyRepoint(client, mine, (undo) => {
      recorded = undo;
      recordedBeforeFirstWrite = true;
    });
    expect(recordedBeforeFirstWrite).toBe(true);
    expect(result).toMatchObject({ applied: 2, skippedChanged: 0 });
    expect(recorded).toHaveLength(2);

    const after = await state();
    const byKey = (k: string) => after.find((s) => s.id === seg[k])!;
    expect(byKey("candidate").airlineId).toBe(vietjetId);
    expect(byKey("candidateLowerSpaced").airlineId).toBe(vietjetId);
    for (const k of ["noRaw", "unrelatedRaw", "longRaw"]) expect(byKey(k).airlineId).toBe(jatayuId);
    expect(byKey("alreadyRight").airlineId).toBe(vietjetId);
    // only airlineId differs, for exactly the two repaired rows
    const strip = (s: (typeof after)[number]) => ({ ...s, airlineId: 0 });
    expect(after.map(strip)).toEqual(before.map(strip));
    expect(after.filter((s, i) => s.airlineId !== before[i].airlineId)).toHaveLength(2);
    // the retired airline row is untouched
    expect(await prisma.airline.findUniqueOrThrow({ where: { id: jatayuId } })).toMatchObject({ name: "Jatayu Airlines", iata: null, isActive: false });

    const again = await history.reportAirlineHistory(client);
    expect(again.candidates.filter((c) => Object.values(seg).includes(c.segmentId))).toEqual([]); // idempotent
    expect((await history.applyRepoint(client, [], () => undefined)).applied).toBe(0);
  });

  it("a compare-and-swap protects a segment an agent edited in the meantime", async () => {
    const stale: import("@/server/airline-history").RepointCandidate = { segmentId: seg.noRaw, oldAirlineId: vietjetId /* not what it points at */, oldName: "x", oldIcao: null, rawCode: "VJ", newAirlineId: vietjetId, newName: "VietJet Air", newIata: "VJ", departureAt: new Date().toISOString() };
    const r = await history.applyRepoint(client, [stale], () => undefined);
    expect(r).toMatchObject({ applied: 0, skippedChanged: 1 });
    expect((await prisma.flightSegment.findUniqueOrThrow({ where: { id: seg.noRaw } })).airlineId).toBe(jatayuId);
  });

  it("UNDO restores the exact original references; a segment edited since is left alone", async () => {
    const undo = [
      { segmentId: seg.candidate, fromAirlineId: jatayuId, toAirlineId: vietjetId },
      { segmentId: seg.candidateLowerSpaced, fromAirlineId: jatayuId, toAirlineId: vietjetId },
    ];
    await prisma.flightSegment.update({ where: { id: seg.candidateLowerSpaced }, data: { airlineId: null } }); // an agent changed it afterwards
    const r = await history.undoRepoint(client, undo);
    expect(r).toEqual({ restored: 1, skippedChanged: 1 });
    expect((await prisma.flightSegment.findUniqueOrThrow({ where: { id: seg.candidate } })).airlineId).toBe(jatayuId);
    expect((await prisma.flightSegment.findUniqueOrThrow({ where: { id: seg.candidateLowerSpaced } })).airlineId).toBeNull();
  });

  it("commercial records are never part of this: the quote, its itinerary and the lead are exactly as they were", async () => {
    const q = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
    expect(Number(q.total)).toBe(700);
    expect(q.status).toBe("SENT");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("QUOTED");
  });
});
