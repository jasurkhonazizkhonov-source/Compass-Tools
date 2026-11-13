import { describe, it, expect } from "vitest";
import airports from "@/data/reference/airports.json";

// Integrity of the BUNDLED airport dataset (what a fresh or self-healed database is seeded with). Measured 2026-11-13: 9,052 rows, every IATA a
// 3-letter code with no duplicate, 7,814 rows with a real ICAO (none duplicated). The rules below are the database's own (Airport.iata @unique) plus
// the format rules that keep an IATA from being confused with an ICAO or an airline designator. Nothing here invents data: it only checks what is there.

type Row = { iata: string; icao: string | null; name: string; city: string; country: string; countryCode: string | null; latitude: number | null; longitude: number | null; timezone: string | null };
const rows = airports as Row[];

describe("bundled airport reference data - integrity", () => {
  it("is the expected size (a truncated or emptied bundle would silently shrink the search)", () => {
    expect(rows.length).toBeGreaterThan(9000);
  });

  it("every IATA is exactly three upper-case letters, and none appears twice (Airport.iata is unique)", () => {
    const bad = rows.filter((r) => !/^[A-Z]{3}$/.test(r.iata)).map((r) => r.iata);
    expect(bad).toEqual([]);
    expect(new Set(rows.map((r) => r.iata)).size).toBe(rows.length);
  });

  it("an ICAO, when present, is a 3-4 character upper-case code, is never a copy of the IATA field, and is not shared by two airports", () => {
    const withIcao = rows.filter((r) => r.icao);
    expect(withIcao.filter((r) => !/^[A-Z0-9]{3,4}$/.test(r.icao!)).map((r) => r.icao)).toEqual([]);
    expect(withIcao.filter((r) => r.icao!.length === 3 && r.icao === r.iata).length).toBe(0);
    expect(new Set(withIcao.map((r) => r.icao)).size).toBe(withIcao.length);
  });

  it("every airport has a name, a country and a country code, plus a valid time zone and coordinates in range", () => {
    for (const r of rows) {
      expect(r.name.trim(), r.iata).not.toBe("");
      expect(r.country.trim(), r.iata).not.toBe("");
      expect(r.countryCode, r.iata).toMatch(/^[A-Z]{2}$/);
      expect(r.latitude, r.iata).toBeGreaterThanOrEqual(-90);
      expect(r.latitude, r.iata).toBeLessThanOrEqual(90);
      expect(r.longitude, r.iata).toBeGreaterThanOrEqual(-180);
      expect(r.longitude, r.iata).toBeLessThanOrEqual(180);
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: r.timezone ?? undefined }), r.iata).not.toThrow();
    }
  });

  it("the major hubs are present with their well-known codes (a spot check that IATA and ICAO were not swapped)", () => {
    const by = new Map(rows.map((r) => [r.iata, r]));
    expect(by.get("JFK")).toMatchObject({ icao: "KJFK", countryCode: "US" });
    expect(by.get("LHR")).toMatchObject({ icao: "EGLL", countryCode: "GB" });
    expect(by.get("DXB")).toMatchObject({ icao: "OMDB", countryCode: "AE" });
    expect(by.get("SYD")).toMatchObject({ icao: "YSSY", countryCode: "AU" });
  });
});
