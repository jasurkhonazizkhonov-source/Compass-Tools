// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCityDatabase } from "./mmdb-fixture";
import { installDatabaseFile, validateDatabaseFile } from "../geoip-database-file";
import { describeLocationSource, geoAttributionFor } from "../geoip-attribution";

const dir = mkdtempSync(path.join(tmpdir(), "geoip-file-"));
const good = buildCityDatabase({ entries: [{ cidr: "203.0.113.0/24", record: { city: "Frankfurt am Main", country: { name: "Germany", iso: "DE" } } }] });
const goodFile = path.join(dir, "good.mmdb");
beforeAll(() => writeFileSync(goodFile, good));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("validateDatabaseFile", () => {
  it("accepts a City database and reports its type, build date, IP version and a sample lookup", async () => {
    const info = await validateDatabaseFile(goodFile, ["203.0.113.9", "198.51.100.1"]);
    expect(info).toMatchObject({ databaseType: "DBIP-City-Lite", ipVersion: 6 });
    expect(info.builtAt.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(info.samples).toEqual([
      { ip: "203.0.113.9", found: true, country: "Germany", city: "Frankfurt am Main" },
      { ip: "198.51.100.1", found: false, country: undefined, city: undefined },
    ]);
  });

  it("refuses a missing file, a tiny/truncated file, a gzip file and non-MMDB data", async () => {
    await expect(validateDatabaseFile(path.join(dir, "nope.mmdb"))).rejects.toThrow();
    writeFileSync(path.join(dir, "tiny.mmdb"), Buffer.from("x"));
    await expect(validateDatabaseFile(path.join(dir, "tiny.mmdb"))).rejects.toThrow(/too small/);
    writeFileSync(path.join(dir, "zipped.mmdb"), gzipSync(Buffer.concat([good, randomBytes(2000)]))); // incompressible padding keeps it above the size floor
    await expect(validateDatabaseFile(path.join(dir, "zipped.mmdb"))).rejects.toThrow(/gzip/i);
    writeFileSync(path.join(dir, "text.mmdb"), "not a database ".repeat(200));
    await expect(validateDatabaseFile(path.join(dir, "text.mmdb"))).rejects.toThrow();
    await expect(validateDatabaseFile(dir)).rejects.toThrow(/not a file/);
  });

  it("refuses a database that is not a City database", async () => {
    const asn = path.join(dir, "asn.mmdb");
    writeFileSync(asn, Buffer.concat([buildCityDatabase({ databaseType: "GeoLite2-ASN", entries: [{ cidr: "203.0.113.0/24", record: { country: { name: "Germany", iso: "DE" } } }] }), Buffer.alloc(1100)]));
    await expect(validateDatabaseFile(asn)).rejects.toThrow(/not a City database/);
  });

  it("refuses a build date in the future", async () => {
    const future = path.join(dir, "future.mmdb");
    writeFileSync(future, Buffer.concat([buildCityDatabase({ buildEpochSec: Math.floor(Date.now() / 1000) + 90 * 86400, entries: [{ cidr: "203.0.113.0/24", record: { country: { name: "Germany", iso: "DE" } } }] }), Buffer.alloc(1100)]));
    await expect(validateDatabaseFile(future)).rejects.toThrow(/future/);
  });
});

describe("installDatabaseFile", () => {
  it("installs into a directory that does not exist yet, leaving no temporary file behind", async () => {
    const target = path.join(dir, "fresh", "geoip", "city.mmdb");
    await installDatabaseFile(goodFile, target);
    expect(readFileSync(target).equals(good)).toBe(true);
    expect(existsSync(`${target}.incoming`)).toBe(false);
    expect(existsSync(`${target}.previous`)).toBe(false);
  });

  it("keeps the previous database beside the new one so an operator can roll back", async () => {
    const target = path.join(dir, "replace.mmdb");
    const older = buildCityDatabase({ buildEpochSec: Math.floor(Date.UTC(2026, 9, 1) / 1000), entries: [{ cidr: "203.0.113.0/24", record: { country: { name: "Germany", iso: "DE" } } }] });
    writeFileSync(target, older);
    await installDatabaseFile(goodFile, target);
    expect(readFileSync(target).equals(good)).toBe(true);
    expect(readFileSync(`${target}.previous`).equals(older)).toBe(true);
  });

  it("a bad candidate never replaces a working database", async () => {
    const target = path.join(dir, "keep.mmdb");
    writeFileSync(target, good);
    const bad = path.join(dir, "bad-candidate.mmdb");
    writeFileSync(bad, "half a download ".repeat(300));
    await expect(installDatabaseFile(bad, target)).rejects.toThrow();
    expect(readFileSync(target).equals(good)).toBe(true);
    expect(existsSync(`${target}.incoming`)).toBe(false);
  });
});

describe("attribution and the location tooltip", () => {
  it("names DB-IP for a DB-IP source and MaxMind for a GeoLite source, once each", () => {
    expect(geoAttributionFor(["DBIP-City-Lite (2026-11-01)", "DBIP-City-Lite (2026-10-01)", null])).toEqual(["IP geolocation by DB-IP (https://db-ip.com), licensed under CC BY 4.0."]);
    expect(geoAttributionFor(["GeoLite2-City (2026-11-04)"])).toEqual(["This product includes GeoLite data created by MaxMind, available from https://www.maxmind.com."]);
    expect(geoAttributionFor(["GeoLite2-City (2026-11-04)", "DBIP-City-Lite (2026-11-01)"])).toHaveLength(2);
  });

  it("needs no credit for the edge's own country header, for the platform's headers, or when there is no source", () => {
    expect(geoAttributionFor(["Cloudflare edge country (CF-IPCountry)", "Vercel edge geolocation (approximate)", undefined, null])).toEqual([]);
  });

  it("the tooltip says the location is approximate and where it came from; nothing when the source is unknown", () => {
    expect(describeLocationSource("DBIP-City-Lite (2026-11-01)", new Date("2026-11-08T10:00:00Z"))).toBe("Approximate, estimated from the sign-in IP address (DBIP-City-Lite (2026-11-01), looked up 2026-11-08)");
    expect(describeLocationSource(null, null)).toBeNull();
  });
});
