import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import airlines from "@/data/reference/airlines.json";
import curated from "../../../prisma/seed-data/airlines-curated.json";
import { applyCuratedAirlines, sanitizeAirlineRows, IATA_PATTERN, ICAO_PATTERN, type CuratedAirlineFile } from "../../../prisma/seed-data/curated-airlines";
import { IATA_CODES_WITHOUT_CDN_LOGO, airlineLogoUrl } from "@/lib/airline-logo";
import { foldAirlineText, rankAirlineMatches } from "@/lib/airline-search";
import { resolveAirlineDisplay } from "@/lib/canonical-segment";

type Row = { iata: string | null; icao: string | null; name: string; country: string | null; isActive: boolean };
const rows = airlines as Row[];
const file = curated as unknown as CuratedAirlineFile & { airlines: Array<CuratedAirlineFile["airlines"][number]> };
const byIata = new Map(rows.filter((r) => r.iata).map((r) => [r.iata!, r]));
const find = (iata: string) => byIata.get(iata);

describe("bundled airline reference data — integrity (what a fresh database is seeded with)", () => {
  it("every IATA is a real 2-character designator, every ICAO a real 3-letter one — never swapped or placeholder", () => {
    for (const r of rows) {
      if (r.iata) expect(r.iata, `${r.name}: IATA`).toMatch(IATA_PATTERN);
      if (r.icao) expect(r.icao, `${r.name}: ICAO`).toMatch(ICAO_PATTERN);
    }
  });

  it("no duplicate IATA codes, and no two code-less rows share an ICAO (the database's own uniqueness rules)", () => {
    const iatas = rows.filter((r) => r.iata).map((r) => r.iata);
    expect(new Set(iatas).size).toBe(iatas.length);
    const icaoOnly = rows.filter((r) => !r.iata).map((r) => r.icao);
    expect(icaoOnly.every(Boolean)).toBe(true);
    expect(new Set(icaoOnly).size).toBe(icaoOnly.length);
  });

  it("no two ACTIVE airlines share an ICAO code, so resolving by ICAO can never be ambiguous", () => {
    const seen = new Map<string, string>();
    for (const r of rows.filter((x) => x.iata && x.icao && x.isActive)) {
      expect(seen.has(r.icao!), `ICAO ${r.icao} shared by ${seen.get(r.icao!)} and ${r.name}`).toBe(false);
      seen.set(r.icao!, r.name);
    }
  });

  it("no row without any code, and every row has a name", () => {
    for (const r of rows) {
      expect(r.name.trim().length).toBeGreaterThan(0);
      expect(r.iata || r.icao).toBeTruthy();
    }
  });
});

describe("curated airlines — every entry is a verified IATA + ICAO pair, applied to the bundle", () => {
  it("each curated airline has a valid code pair, two cross-check sources, and is present in the bundle with that exact pair", () => {
    expect(file.airlines.length).toBeGreaterThan(150);
    for (const e of file.airlines) {
      expect(e.iata, e.name).toMatch(IATA_PATTERN);
      expect(e.icao, e.name).toMatch(ICAO_PATTERN);
      expect(e.sources.length, `${e.iata} ${e.name} needs a verifying source`).toBeGreaterThan(0);
      const row = find(e.iata);
      expect(row, `${e.iata} ${e.name} missing from bundle`).toBeDefined();
      expect(row!.icao).toBe(e.icao);
      expect(row!.name).toBe(e.name);
      expect(row!.isActive).toBe(e.isActive);
    }
  });

  it("no curated IATA appears twice", () => {
    const codes = file.airlines.map((e) => e.iata);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("an ICAO code is never placed in the IATA field (and vice versa)", () => {
    for (const e of file.airlines) {
      expect(e.iata.length).toBe(2);
      expect(e.icao.length).toBe(3);
      expect(e.iata).not.toBe(e.icao.slice(0, 2).toLowerCase());
    }
  });

  it.each([
    // recycled codes now point at today's carrier, not the long-defunct one that once held them
    ["PC", "Pegasus Airlines"],
    ["V7", "Volotea"],
    ["SG", "SpiceJet"],
    ["J9", "Jazeera Airways"],
    ["JX", "Starlux Airlines"],
    ["YP", "Air Premia"],
    ["AD", "Azul Brazilian Airlines"],
    ["VB", "Viva Aerobus"],
    ["VJ", "VietJet Air"],
    ["XP", "Avelo Airlines"],
    ["4Y", "Discover Airlines"],
    ["JU", "Air Serbia"],
    ["AZ", "ITA Airways"],
    ["WK", "Edelweiss Air"],
    ["LJ", "Jin Air"],
    ["QP", "Akasa Air"],
  ])("recycled code %s now resolves to the active %s", (iata, name) => {
    const row = find(iata);
    expect(row?.name).toBe(name);
    expect(row?.isActive).toBe(true);
  });

  it.each([
    // representative carriers across regions that must be present, active, with their own canonical name and pair
    ["BA", "BAW"], ["LH", "DLH"], ["AF", "AFR"], ["KL", "KLM"], ["IB", "IBE"], ["TK", "THY"], ["EK", "UAE"], ["QR", "QTR"], ["EY", "ETD"],
    ["SQ", "SIA"], ["CX", "CPA"], ["NH", "ANA"], ["JL", "JAL"], ["KE", "KAL"], ["AI", "AIC"], ["QF", "QFA"], ["NZ", "ANZ"], ["AA", "AAL"],
    ["DL", "DAL"], ["UA", "UAL"], ["AC", "ACA"], ["LA", "LAN"], ["AV", "AVA"], ["ET", "ETH"], ["SA", "SAA"], ["MS", "MSR"], ["KQ", "KQA"],
  ])("well-known carrier %s (%s) is present and active", (iata, icao) => {
    const row = find(iata);
    expect(row?.icao).toBe(icao);
    expect(row?.isActive).toBe(true);
  });

  it("airlines that ceased operating are kept but inactive — never deleted, never offered in the picker", () => {
    for (const d of file.deactivate) {
      if (!d.iata && !d.icao) continue; // a code-less row with no valid ICAO is flagged inactive in an existing database but is not part of the bundle
      const row = rows.find((r) => r.iata === d.iata && r.icao === d.icao && r.name === d.name);
      expect(row, `${d.iata} ${d.name} must still exist`).toBeDefined();
      expect(row!.isActive).toBe(false);
    }
    expect(file.deactivate.length).toBeGreaterThan(30);
    const air = find("AB"); // Air Berlin
    expect(air?.name).toBe("Air Berlin");
    expect(air?.isActive).toBe(false);
  });

  it("a freed code's previous holder is preserved as an inactive record, not erased", () => {
    const names = new Set(rows.map((r) => r.name));
    for (const e of file.airlines.filter((x) => x.frees && x.holder)) {
      // The one exception: a freed holder whose ICAO is already used by another code-less row cannot sit in the bundle
      // (code-less rows are de-duplicated by ICAO); in an existing database it is kept with its ICAO cleared instead.
      const icaoTaken = !!e.holder!.icao && rows.some((r) => !r.iata && r.icao === e.holder!.icao && r.name !== e.holder!.name);
      if (icaoTaken || !e.holder!.icao) continue; // (a holder with no ICAO at all is likewise kept only in an existing database)
      expect(names.has(e.holder!.name), `previous holder of ${e.iata}: ${e.holder!.name}`).toBe(true);
    }
    const jatayu = rows.find((r) => r.name === "Jatayu Airlines");
    expect(jatayu).toMatchObject({ iata: null, isActive: false });
    const alitalia = rows.find((r) => r.name === "Alitalia");
    expect(alitalia).toMatchObject({ iata: null, icao: "AZA", isActive: false });
  });

  it("the bundle is exactly the original OpenFlights data with the curated entries applied (idempotent: applying twice changes nothing)", () => {
    const once = applyCuratedAirlines(rows as never, file);
    const twice = applyCuratedAirlines(once, file);
    expect(twice).toEqual(once);
  });
});

describe("applyCuratedAirlines — the rules, on a small fixture", () => {
  const base = (): Row[] => [
    { iata: "VJ", icao: "JTY", name: "Jatayu Airlines", country: "Indonesia", isActive: false },
    { iata: null, icao: "VJC", name: "VietJet Air", country: "Vietnam", isActive: true },
    { iata: "AZ", icao: "AZA", name: "Alitalia", country: "Italy", isActive: true },
    { iata: "TR", icao: "TGW", name: "Tiger Airways", country: "Singapore", isActive: true },
    { iata: "AB", icao: "BER", name: "Air Berlin", country: "Germany", isActive: true },
  ];
  const f = (airlines: CuratedAirlineFile["airlines"], deactivate: CuratedAirlineFile["deactivate"] = []): CuratedAirlineFile => ({ airlines, deactivate });
  const entry = (o: Partial<CuratedAirlineFile["airlines"][number]> & Pick<CuratedAirlineFile["airlines"][number], "iata" | "icao" | "name" | "mode">): CuratedAirlineFile["airlines"][number] => ({ country: "X", isActive: true, logo: true, sources: ["t"], ...o });

  it("adopt: a recycled code leaves its old holder (kept, inactive) and the airline's own code-less row gains it", () => {
    const out = applyCuratedAirlines(base(), f([entry({ iata: "VJ", icao: "VJC", name: "VietJet Air", mode: "adopt", frees: true, own: { name: "VietJet Air", icao: "VJC", iata: null } })]));
    expect(out.find((r) => r.name === "Jatayu Airlines")).toMatchObject({ iata: null, isActive: false });
    expect(out.find((r) => r.iata === "VJ")).toMatchObject({ name: "VietJet Air", icao: "VJC", isActive: true });
    expect(out.filter((r) => r.name === "VietJet Air")).toHaveLength(1);
  });

  it("relabel: the same company renamed keeps its row; a materially different old name is kept as an inactive code-less record", () => {
    const out = applyCuratedAirlines(base(), f([entry({ iata: "AZ", icao: "ITY", name: "ITA Airways", mode: "relabel", keepPrevious: true, holder: { name: "Alitalia", icao: "AZA" } })]));
    expect(out.find((r) => r.iata === "AZ")).toMatchObject({ name: "ITA Airways", icao: "ITY", isActive: true });
    expect(out.find((r) => r.name === "Alitalia")).toMatchObject({ iata: null, icao: "AZA", isActive: false });
  });

  it("update: same IATA + ICAO — only the canonical name / flag changes", () => {
    const out = applyCuratedAirlines(base(), f([entry({ iata: "TR", icao: "TGW", name: "Scoot", mode: "update" })]));
    expect(out.find((r) => r.iata === "TR")).toMatchObject({ name: "Scoot", icao: "TGW" });
    expect(out).toHaveLength(base().length);
  });

  it("insert: an airline that is not in the data is added", () => {
    const out = applyCuratedAirlines(base(), f([entry({ iata: "QP", icao: "AKJ", name: "Akasa Air", mode: "insert" })]));
    expect(out.find((r) => r.iata === "QP")).toMatchObject({ name: "Akasa Air", icao: "AKJ", isActive: true });
  });

  it("deactivate flips only the flag, and only on an exact (IATA, ICAO, name) match", () => {
    const out = applyCuratedAirlines(base(), f([], [{ iata: "AB", icao: "BER", name: "Air Berlin" }, { iata: "TR", icao: "TGW", name: "Wrong Name" }]));
    expect(out.find((r) => r.iata === "AB")?.isActive).toBe(false);
    expect(out.find((r) => r.iata === "TR")?.isActive).toBe(true);
    expect(out).toHaveLength(base().length);
  });

  it("never deletes a row and never leaves two rows with the same IATA", () => {
    const out = applyCuratedAirlines(base(), f([entry({ iata: "VJ", icao: "VJC", name: "VietJet Air", mode: "adopt", own: { name: "VietJet Air", icao: "VJC", iata: null } })]));
    const codes = out.filter((r) => r.iata).map((r) => r.iata);
    expect(new Set(codes).size).toBe(codes.length);
    for (const b of base()) expect(out.some((r) => r.name === b.name)).toBe(true);
  });
});

describe("sanitizeAirlineRows — placeholder designators in the old data", () => {
  it("drops non-designator IATA/ICAO values but keeps the airline when it still has a real code", () => {
    const out = sanitizeAirlineRows([
      { iata: "--", icao: "ELK", name: "ELK Airways", country: null, isActive: true },
      { iata: "8z", icao: "LER", name: "Linea Aerea", country: null, isActive: false },
      { iata: "ЯП", icao: null, name: "Polar Airlines", country: null, isActive: true },
      { iata: "BA", icao: "BA1", name: "Odd", country: null, isActive: true },
    ] as never);
    expect(out.map((r) => [r.name, r.iata, r.icao])).toEqual([
      ["ELK Airways", null, "ELK"],
      ["Linea Aerea", null, "LER"],
      ["Odd", "BA", null],
    ]);
  });
});

describe("migration 20261005000100_airline_reference_refresh", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../../prisma/migrations/20261005000100_airline_reference_refresh/migration.sql"), "utf-8");

  it("never deletes, drops or truncates anything", () => {
    const statements = sql.replace(/--.*$/gm, "");
    expect(statements).not.toMatch(/\b(DELETE|DROP|TRUNCATE|ALTER\s+TABLE)\b/i);
  });

  it("contains every curated airline and every deactivation, with the same codes (SQL and JSON cannot drift)", () => {
    for (const e of file.airlines) {
      expect(sql, `${e.iata} ${e.name}`).toContain(`('${e.iata}'::text, '${e.icao}'::text, '${e.name.replace(/'/g, "''")}'::text`);
    }
    for (const d of file.deactivate) {
      const lit = (v: string | null) => (v == null ? "NULL::text" : `'${v.replace(/'/g, "''")}'::text`);
      expect(sql).toContain(`(${lit(d.iata)}, ${lit(d.icao)}, ${lit(d.name)})`);
    }
  });

  it("is applied per-airline in its own sub-transaction so one unexpected row cannot abort a deploy", () => {
    expect(sql).toContain("EXCEPTION WHEN OTHERS THEN");
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
  });
});

describe("airline logos — coverage and the fallback", () => {
  it("every curated airline either has a verified CDN logo, or is on the no-logo list that triggers the existing fallback", () => {
    for (const e of file.airlines) {
      const url = airlineLogoUrl(e.iata);
      if (e.logo) {
        expect(url, e.iata).toBe(`https://images.kiwi.com/airlines/64x64/${e.iata}.png`);
      } else {
        expect(IATA_CODES_WITHOUT_CDN_LOGO.has(e.iata), `${e.iata} has no logo and must be on the fallback list`).toBe(true);
        expect(url).toBeNull();
      }
    }
  });

  it("the no-logo list contains only airlines that really lack a logo (no stale entries)", () => {
    const missing = new Set(file.airlines.filter((e) => !e.logo).map((e) => e.iata));
    for (const code of IATA_CODES_WITHOUT_CDN_LOGO) expect(missing.has(code), code).toBe(true);
  });

  it("an airline without a logo displays through the existing code-box fallback, never a broken image", () => {
    const display = resolveAirlineDisplay({ name: "Breeze Airways", iata: "MX", icao: "MXY", logoUrl: null }, "MX");
    expect(display.logoUrl).toBeNull();
    expect(display.name).toBe("Breeze Airways");
    expect(display.code).toBe("MX");
  });

  it("an airline with a logo gets its own, an explicit database logo still wins, and a malformed code gets none", () => {
    expect(resolveAirlineDisplay({ name: "Pegasus Airlines", iata: "PC", icao: "PGT", logoUrl: null }, "PC").logoUrl).toBe("https://images.kiwi.com/airlines/64x64/PC.png");
    expect(resolveAirlineDisplay({ name: "X", iata: "PC", icao: "PGT", logoUrl: "https://cdn.example.com/pc.png" }, "PC").logoUrl).toBe("https://cdn.example.com/pc.png");
    expect(airlineLogoUrl("--")).toBeNull();
    expect(airlineLogoUrl(null)).toBeNull();
  });
});

describe("airline picker ranking — exact codes and names first, never a silent wrong pick", () => {
  const pool = [
    { id: 1, iata: "PC", icao: "PGT", name: "Pegasus Airlines" },
    { id: 2, iata: null, icao: "PEG", name: "Pegasus Aviation Services" },
    { id: 3, iata: "XX", icao: "XXX", name: "Air Pegasus Express Cargo Line" },
    { id: 4, iata: "AM", icao: "AMX", name: "Aeroméxico" },
    { id: 5, iata: "AR", icao: "ARG", name: "Aerolíneas Argentinas" },
    { id: 6, iata: "AH", icao: "DAH", name: "Air Algérie" },
    { id: 7, iata: "A3", icao: "AEE", name: "Aegean Airlines" },
    { id: 8, iata: "JU", icao: "ASL", name: "Air Serbia" },
    { id: 9, iata: "QR", icao: "QTR", name: "Qatar Airways" },
    { id: 10, iata: "PA", icao: "ABQ", name: "Airblue" },
  ];
  const top = (q: string) => rankAirlineMatches(pool, q)[0]?.name;

  it("an exact IATA code wins over a name that merely contains the same letters", () => {
    expect(top("pc")).toBe("Pegasus Airlines");
    expect(top("QR")).toBe("Qatar Airways");
    expect(top("a3")).toBe("Aegean Airlines");
  });

  it("an exact name wins; then names starting with the text; then a word starting with it; then contains", () => {
    expect(top("Air Serbia")).toBe("Air Serbia");
    const order = rankAirlineMatches(pool, "pegasus").map((a) => a.name);
    expect(order[0]).toBe("Pegasus Airlines"); // starts with + has an IATA code
    expect(order.slice(0, 3)).toEqual(["Pegasus Airlines", "Pegasus Aviation Services", "Air Pegasus Express Cargo Line"]);
  });

  it("an exact ICAO code is found after an exact IATA / name match", () => {
    expect(top("PGT")).toBe("Pegasus Airlines");
  });

  it("accent-insensitive: typing without accents matches the accented canonical name", () => {
    expect(foldAirlineText("Aeroméxico")).toBe("aeromexico");
    expect(top("aeromexico")).toBe("Aeroméxico");
    expect(top("aerolineas argentinas")).toBe("Aerolíneas Argentinas");
    expect(top("air algerie")).toBe("Air Algérie");
  });

  it("is deterministic: the same input always ranks the same way", () => {
    expect(rankAirlineMatches(pool, "air").map((a) => a.id)).toEqual(rankAirlineMatches([...pool].reverse(), "air").map((a) => a.id));
  });
});
