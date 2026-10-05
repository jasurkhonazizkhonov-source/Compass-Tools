// Curated corrections and additions to the bundled OpenFlights airline data.
//
// `airlines-curated.json` (next to this file) is the single, reviewable source of truth for them: every
// entry carries an IATA (2-character) + ICAO (3-letter) pair that was cross-checked against two independent
// sources, never inferred from a name. This module holds the one implementation of "apply those entries to a
// list of airline rows" — used when the bundled JSON is generated (parse.ts -> generate-json.ts) so a brand-new
// database starts out correct. The same rules are applied to an EXISTING database by migration
// 20261005000100_airline_reference_refresh (generated from the same JSON by generate-airline-migration.ts).
//
// Rules (per curated entry, in file order):
//   update   the row holding the IATA is already this airline (same ICAO): set the canonical name / active flag.
//   relabel  the row holding the IATA is the same company renamed, or its successor on the same code: it is
//            relabelled in place (so existing references keep pointing at the right carrier); when the old name is
//            materially different the previous identity is kept as an inactive record WITHOUT an IATA code.
//   adopt/insert  the IATA was recycled from an unrelated, usually defunct, airline: that row keeps its identity
//            (name, ICAO, id) but is marked inactive and loses the code, so historical references are preserved and
//            nothing is deleted; the airline's own existing ICAO-only row gains the code, or a new row is added.
// `deactivate` entries only ever flip isActive to false.
import fs from "node:fs";
import path from "node:path";
import type { ParsedAirline } from "./parse";

export type CuratedAirline = {
  iata: string;
  icao: string;
  name: string;
  country: string;
  isActive: boolean;
  mode: "update" | "relabel" | "adopt" | "insert";
  frees?: boolean;
  keepPrevious?: boolean;
  holder?: { name: string; icao: string | null };
  own?: { name: string; icao: string | null; iata: string | null };
  logo: boolean;
  sources: string[];
};

export type CuratedAirlineFile = {
  airlines: CuratedAirline[];
  deactivate: Array<{ iata: string | null; icao: string | null; name: string }>;
};

export const IATA_PATTERN = /^[A-Z0-9]{2}$/;
export const ICAO_PATTERN = /^[A-Z]{3}$/;

export function loadCuratedAirlines(): CuratedAirlineFile {
  const raw = fs.readFileSync(path.join(__dirname, "airlines-curated.json"), "utf-8");
  return JSON.parse(raw) as CuratedAirlineFile;
}

/**
 * Drops IATA/ICAO values that are not real designators (the OpenFlights file contains placeholders such as
 * "--", "??", "8z" or a Cyrillic string in the IATA column). A row keeps whatever valid code it still has;
 * a row left with neither is dropped from the bundle. Existing database rows are never deleted by this.
 */
export function sanitizeAirlineRows(rows: ParsedAirline[]): ParsedAirline[] {
  const out: ParsedAirline[] = [];
  for (const row of rows) {
    const iata = row.iata && IATA_PATTERN.test(row.iata) ? row.iata : null;
    const icao = row.icao && ICAO_PATTERN.test(row.icao) ? row.icao : null;
    if (!iata && !icao) continue;
    out.push({ ...row, iata, icao });
  }
  return out;
}

export function applyCuratedAirlines(input: ParsedAirline[], file: CuratedAirlineFile): ParsedAirline[] {
  const rows: ParsedAirline[] = input.map((r) => ({ ...r }));
  const byIata = (iata: string) => rows.find((r) => r.iata === iata);

  for (const e of file.airlines) {
    const holder = byIata(e.iata);

    if (holder && holder.icao === e.icao) {
      holder.name = e.name;
      holder.isActive = e.isActive;
      holder.country = holder.country ?? e.country;
      continue;
    }

    if (e.mode === "relabel" && holder) {
      if (e.keepPrevious && holder.icao && !rows.some((r) => !r.iata && r.icao === holder.icao)) {
        rows.push({ iata: null, icao: holder.icao, name: holder.name, country: holder.country, isActive: false });
      }
      holder.name = e.name;
      holder.icao = e.icao;
      holder.isActive = e.isActive;
      holder.country = holder.country ?? e.country;
      continue;
    }

    if (holder) {
      holder.iata = null;
      holder.isActive = false;
    }

    const own = e.own ? rows.find((r) => r.name === e.own!.name && r.icao === e.own!.icao && (r.iata === null || r.iata === e.own!.iata)) : undefined;
    if (own) {
      own.iata = e.iata;
      own.icao = e.icao;
      own.name = e.name;
      own.country = own.country ?? e.country;
      own.isActive = e.isActive;
    } else {
      rows.push({ iata: e.iata, icao: e.icao, name: e.name, country: e.country, isActive: e.isActive });
    }
  }

  for (const d of file.deactivate) {
    const row = rows.find((r) => r.iata === d.iata && r.icao === d.icao && r.name === d.name);
    if (row) row.isActive = false;
  }

  // Same invariants the database enforces: IATA unique; ICAO unique among rows with no IATA.
  const seenIata = new Set<string>();
  const seenIcao = new Set<string>();
  return rows.filter((r) => {
    if (r.iata) {
      if (seenIata.has(r.iata)) return false;
      seenIata.add(r.iata);
      return true;
    }
    if (!r.icao) return false;
    if (seenIcao.has(r.icao)) return false;
    seenIcao.add(r.icao);
    return true;
  });
}
