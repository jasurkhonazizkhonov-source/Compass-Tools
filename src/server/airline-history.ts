// Operator tool support for historical flight segments that still point at an airline row whose IATA code was recycled.
//
// Background (docs/AIRLINE_REFERENCE_DATA.md): when a code that once belonged to a defunct airline was issued to a different,
// current one, the airline refresh migration kept the OLD row (id, name, ICAO — marked inactive, code removed) so no
// historical reference was lost, and gave the code to the current airline. A segment saved BEFORE that, against the old row,
// therefore still shows the old airline's name even though the agent entered / pasted the current airline's code
// (FlightSegment.airlineCodeRaw keeps that code as entered).
//
// This module finds those segments and, ONLY when explicitly run with apply + confirm, re-points them. It never guesses:
//   • a segment is a candidate only when its OWN stored raw code is exactly a 2-character IATA code that an ACTIVE airline
//     holds today, and it currently points at a retired row (inactive, no IATA) that is a different airline;
//   • segments with no raw code, or a raw code nobody holds, are reported as "cannot be inferred" and left alone;
//   • only FlightSegment.airlineId changes — never a time, a price, a flight number, a quote, a booking or an email already sent;
//   • every change is a compare-and-swap, is recorded in an undo list BEFORE it is made, and can be reversed exactly;
//   • a second run finds nothing to do.
// Nothing here is reachable from a web request.
import type { Queryable } from "@/server/security/card-key-rotation";

export type RepointCandidate = {
  segmentId: string;
  oldAirlineId: number;
  oldName: string;
  oldIcao: string | null;
  rawCode: string;
  newAirlineId: number;
  newName: string;
  newIata: string;
  departureAt: string;
};

export type HistoryReport = {
  segmentsWithAirline: number;
  /** Segments pointing at a retired, code-less airline row. */
  onRetiredRows: number;
  candidates: RepointCandidate[];
  /** Retired-row segments whose stored code is missing or not held by any active airline today — not inferable, left alone. */
  notInferable: number;
  byPair: Array<{ from: string; to: string; segments: number; firstDeparture: string; lastDeparture: string }>;
};

const CANDIDATE_SQL = (withSince: boolean) => `
  SELECT s."id" AS "segmentId", s."airlineId" AS "oldAirlineId", o."name" AS "oldName", o."icao" AS "oldIcao",
         upper(btrim(s."airlineCodeRaw")) AS "rawCode", c."id" AS "newAirlineId", c."name" AS "newName", c."iata" AS "newIata",
         s."departureAt" AS "departureAt"
    FROM "FlightSegment" s
    JOIN "Airline" o ON o."id" = s."airlineId"
    JOIN "Airline" c ON c."iata" = upper(btrim(s."airlineCodeRaw")) AND c."isActive" = true
   WHERE o."iata" IS NULL AND o."isActive" = false AND c."id" <> o."id"
     AND char_length(btrim(s."airlineCodeRaw")) = 2
     ${withSince ? 'AND s."departureAt" >= $1' : ""}
   ORDER BY s."id"`;

export async function reportAirlineHistory(db: Queryable, options: { since?: Date } = {}): Promise<HistoryReport> {
  const total = await db.query(`SELECT count(*)::int AS n FROM "FlightSegment" WHERE "airlineId" IS NOT NULL`);
  const retired = await db.query(
    `SELECT count(*)::int AS n FROM "FlightSegment" s JOIN "Airline" o ON o."id" = s."airlineId" WHERE o."iata" IS NULL AND o."isActive" = false${options.since ? ' AND s."departureAt" >= $1' : ""}`,
    options.since ? [options.since] : []
  );
  const { rows } = await db.query(CANDIDATE_SQL(!!options.since), options.since ? [options.since] : []);
  const candidates: RepointCandidate[] = rows.map((r) => ({
    segmentId: String(r.segmentId),
    oldAirlineId: Number(r.oldAirlineId),
    oldName: String(r.oldName),
    oldIcao: r.oldIcao == null ? null : String(r.oldIcao),
    rawCode: String(r.rawCode),
    newAirlineId: Number(r.newAirlineId),
    newName: String(r.newName),
    newIata: String(r.newIata),
    departureAt: new Date(r.departureAt as string | Date).toISOString(),
  }));
  const pairs = new Map<string, HistoryReport["byPair"][number]>();
  for (const c of candidates) {
    const key = `${c.oldAirlineId}>${c.newAirlineId}`;
    const p = pairs.get(key) ?? { from: `${c.oldName}${c.oldIcao ? ` (${c.oldIcao})` : ""}`, to: `${c.newName} (${c.newIata})`, segments: 0, firstDeparture: c.departureAt, lastDeparture: c.departureAt };
    p.segments++;
    if (c.departureAt < p.firstDeparture) p.firstDeparture = c.departureAt;
    if (c.departureAt > p.lastDeparture) p.lastDeparture = c.departureAt;
    pairs.set(key, p);
  }
  const onRetiredRows = Number(retired.rows[0]?.n ?? 0);
  return { segmentsWithAirline: Number(total.rows[0]?.n ?? 0), onRetiredRows, candidates, notInferable: onRetiredRows - candidates.length, byPair: [...pairs.values()] };
}

export type UndoEntry = { segmentId: string; fromAirlineId: number; toAirlineId: number };
export type ApplyResult = { applied: number; skippedChanged: number; undo: UndoEntry[] };

/**
 * Re-points the given candidates. `recordUndo` is called with the COMPLETE undo list before the first write, so an operator
 * who is interrupted mid-run still has the exact record needed to reverse it.
 */
export async function applyRepoint(db: Queryable, candidates: RepointCandidate[], recordUndo: (undo: UndoEntry[]) => void | Promise<void>): Promise<ApplyResult> {
  const undo = candidates.map((c) => ({ segmentId: c.segmentId, fromAirlineId: c.oldAirlineId, toAirlineId: c.newAirlineId }));
  await recordUndo(undo);
  let applied = 0;
  let skippedChanged = 0;
  for (const u of undo) {
    const res = await db.query(`UPDATE "FlightSegment" SET "airlineId" = $1 WHERE "id" = $2 AND "airlineId" = $3`, [u.toAirlineId, u.segmentId, u.fromAirlineId]);
    if ((res.rowCount ?? 0) === 1) applied++;
    else skippedChanged++;
  }
  return { applied, skippedChanged, undo };
}

/** Reverses an earlier apply from its undo list; a segment edited since is left alone. */
export async function undoRepoint(db: Queryable, undo: UndoEntry[]): Promise<{ restored: number; skippedChanged: number }> {
  let restored = 0;
  let skippedChanged = 0;
  for (const u of undo) {
    const res = await db.query(`UPDATE "FlightSegment" SET "airlineId" = $1 WHERE "id" = $2 AND "airlineId" = $3`, [u.fromAirlineId, u.segmentId, u.toAirlineId]);
    if ((res.rowCount ?? 0) === 1) restored++;
    else skippedChanged++;
  }
  return { restored, skippedChanged };
}
