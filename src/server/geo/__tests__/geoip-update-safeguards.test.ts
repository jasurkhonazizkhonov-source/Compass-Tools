// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCityDatabase } from "./mmdb-fixture";
import { installDatabaseFile, LOCK_STALE_MS } from "../geoip-database-file";
import { readUpdateStatus, recordUpdateAttempt, safeReason, updateStatusPath } from "../geoip-update-status";

// The update path must never put a worse database in place of a working one, must not let two updates collide, and must leave a record of what happened. Every network and place is
// fictional or a documentation range; the databases are generated in memory (mmdb-fixture.ts). No real geolocation data and no real address is used.
const root = mkdtempSync(path.join(tmpdir(), "geoip-safe-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const T = (y: number, m: number) => Math.floor(Date.UTC(y, m - 1, 1) / 1000);
const frankfurt = { city: "Frankfurt am Main", subdivision: { name: "Hesse" }, country: { name: "Germany", iso: "DE" } };
/** A City database with `n` fictional /24 networks; more networks = a bigger file. */
function database(buildEpochSec: number, n = 1) {
  return buildCityDatabase({ buildEpochSec, entries: Array.from({ length: n }, (_, i) => ({ cidr: `203.0.${i % 256}.0/24`, record: { ...frankfurt, city: `City number ${i}` } })) });
}

let dir: string;
let target: string;
const files = () => readdirSync(dir).sort();
const put = (name: string, buf: Buffer | string) => {
  const p = path.join(dir, name);
  writeFileSync(p, buf);
  return p;
};
beforeEach(() => {
  dir = mkdtempSync(path.join(root, "case-"));
  target = path.join(dir, "city.mmdb");
});

describe("installDatabaseFile - a worse file never replaces a working one", () => {
  it("refuses a database built EARLIER than the installed one, changes nothing and leaves no temporary or lock file", async () => {
    const current = database(T(2026, 11));
    writeFileSync(target, current);
    const older = put("older.mmdb", database(T(2026, 9)));
    await expect(installDatabaseFile(older, target)).rejects.toThrow(/earlier than the installed one/);
    expect(readFileSync(target).equals(current)).toBe(true);
    expect(files()).toEqual(["city.mmdb", "older.mmdb"]);
  });

  it("the same older file is installed when the operator says so (a deliberate rollback), and the file it replaced is kept", async () => {
    const current = database(T(2026, 11));
    writeFileSync(target, current);
    const older = database(T(2026, 9));
    await installDatabaseFile(put("older.mmdb", older), target, { allowOlder: true });
    expect(readFileSync(target).equals(older)).toBe(true);
    expect(readFileSync(`${target}.previous`).equals(current)).toBe(true);
  });

  it("refuses a file less than half the size of the installed one (a different, smaller edition or a stripped file), unless allowed", async () => {
    const big = database(T(2026, 10), 400);
    const small = database(T(2026, 11), 1);
    expect(small.length).toBeLessThan(big.length / 2);
    writeFileSync(target, big);
    const candidate = put("small.mmdb", small);
    await expect(installDatabaseFile(candidate, target)).rejects.toThrow(/less than half the installed one/);
    expect(readFileSync(target).equals(big)).toBe(true);
    await installDatabaseFile(candidate, target, { allowSmaller: true });
    expect(readFileSync(target).equals(small)).toBe(true);
  });

  it("an installed file that is itself unusable never blocks a good replacement", async () => {
    writeFileSync(target, "corrupt ".repeat(500));
    const good = database(T(2026, 11));
    await installDatabaseFile(put("new.mmdb", good), target);
    expect(readFileSync(target).equals(good)).toBe(true);
  });

  it("a bad candidate (truncated, not a database) fails before anything is touched: the working file, its bytes and the directory are unchanged", async () => {
    const current = database(T(2026, 10));
    writeFileSync(target, current);
    const truncated = put("truncated.mmdb", database(T(2026, 11), 50).subarray(0, 700));
    await expect(installDatabaseFile(truncated, target)).rejects.toThrow();
    const notDb = put("junk.mmdb", "not a database ".repeat(200));
    await expect(installDatabaseFile(notDb, target)).rejects.toThrow();
    expect(readFileSync(target).equals(current)).toBe(true);
    expect(files()).toEqual(["city.mmdb", "junk.mmdb", "truncated.mmdb"]);
  });
});

describe("installDatabaseFile - two updates cannot run at once", () => {
  it("while another update holds the lock the install is refused, and the lock is left exactly as it was", async () => {
    const current = database(T(2026, 10));
    writeFileSync(target, current);
    const lock = `${target}.lock`;
    writeFileSync(lock, JSON.stringify({ pid: 1, at: new Date().toISOString() }));
    await expect(installDatabaseFile(put("new.mmdb", database(T(2026, 11))), target)).rejects.toThrow(/already running/);
    expect(readFileSync(target).equals(current)).toBe(true);
    expect(existsSync(lock)).toBe(true); // somebody else's lock is never removed by a refused run
  });

  it("a lock left behind by a crashed run (older than the limit) is cleared and the install goes ahead", async () => {
    writeFileSync(target, database(T(2026, 10)));
    const lock = `${target}.lock`;
    writeFileSync(lock, "{}");
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    utimesSync(lock, old, old);
    const fresh = database(T(2026, 11));
    await installDatabaseFile(put("new.mmdb", fresh), target);
    expect(readFileSync(target).equals(fresh)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("the lock is released when the install fails after taking it, so the next attempt is not blocked", async () => {
    writeFileSync(target, database(T(2026, 10)));
    await expect(installDatabaseFile(put("older.mmdb", database(T(2026, 8))), target)).rejects.toThrow(/earlier/);
    expect(existsSync(`${target}.lock`)).toBe(false);
    await installDatabaseFile(put("ok.mmdb", database(T(2026, 11))), target); // not refused as 'already running'
  });

  it("two simultaneous installs never corrupt the database: the file ends up as one of the two good databases, nothing is left over, and a refused one says why", async () => {
    writeFileSync(target, database(T(2026, 9)));
    const a = database(T(2026, 10));
    const b = database(T(2026, 11));
    const results = await Promise.allSettled([installDatabaseFile(put("a.mmdb", a), target), installDatabaseFile(put("b.mmdb", b), target)]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results) if (r.status === "rejected") expect(String((r.reason as Error).message)).toMatch(/already running|earlier than the installed one/);
    const final = readFileSync(target);
    expect(final.equals(a) || final.equals(b)).toBe(true);
    expect(files().filter((f) => /lock|incoming/.test(f))).toEqual([]);
  });
});

describe("the update record (the last attempt, beside the database)", () => {
  it("records a success, then a failure that KEEPS the earlier success time, then a success again", async () => {
    await recordUpdateAttempt(target, "success", undefined, new Date("2026-11-01T04:00:00Z"));
    expect(await readUpdateStatus(target)).toEqual({ lastAttemptAt: new Date("2026-11-01T04:00:00Z"), lastOutcome: "success", lastError: null, lastSuccessAt: new Date("2026-11-01T04:00:00Z") });
    await recordUpdateAttempt(target, "failed", new Error("download failed: HTTP 503"), new Date("2026-12-01T04:00:00Z"));
    expect(await readUpdateStatus(target)).toEqual({ lastAttemptAt: new Date("2026-12-01T04:00:00Z"), lastOutcome: "failed", lastError: "download failed: HTTP 503", lastSuccessAt: new Date("2026-11-01T04:00:00Z") });
    await recordUpdateAttempt(target, "success", undefined, new Date("2026-12-02T04:00:00Z"));
    expect((await readUpdateStatus(target))?.lastError).toBeNull();
    expect((await readUpdateStatus(target))?.lastSuccessAt).toEqual(new Date("2026-12-02T04:00:00Z"));
  });

  it("never stores a file path, control characters or an unbounded message", () => {
    expect(safeReason("ENOENT: no such file or directory, stat 'C:\\Users\\Hp\\AppData\\Local\\Temp\\geoip-1\\city.mmdb'")).not.toMatch(/Users|geoip-1|city\.mmdb/);
    expect(safeReason("open /var/lib/compass-tools/geoip/city.mmdb.incoming-12 failed")).toBe("open <path> failed");
    expect(safeReason("bad\u0000 \u0007thing")).toBe("bad thing");
    expect(safeReason("x".repeat(5000)).length).toBe(200);
    expect(safeReason(undefined)).toBe("the update failed");
  });

  it("a missing, empty, malformed or tampered record is simply 'no record' - never an exception", async () => {
    expect(await readUpdateStatus(path.join(dir, "nothing.mmdb"))).toBeNull();
    for (const body of ["", "not json", "[]", '{"lastAttemptAt":"yesterday","lastOutcome":"success"}', '{"lastAttemptAt":"2026-11-01T00:00:00Z","lastOutcome":"exploded"}']) {
      writeFileSync(updateStatusPath(target), body);
      expect(await readUpdateStatus(target)).toBeNull();
    }
  });

  it("an error text written into the record by someone else is cleaned when it is read", async () => {
    writeFileSync(updateStatusPath(target), JSON.stringify({ lastAttemptAt: "2026-11-01T00:00:00Z", lastOutcome: "failed", lastError: "read /srv/secret/dir/file.txt\u0000 failed", lastSuccessAt: null }));
    expect((await readUpdateStatus(target))?.lastError).toBe("read <path> failed");
  });

  it("recording never throws, even when the directory does not exist", async () => {
    await expect(recordUpdateAttempt(path.join(dir, "no", "such", "dir", "city.mmdb"), "failed", new Error("x"))).resolves.toBeUndefined();
  });
});

describe("the operator command (scripts/geoip-database.ts)", () => {
  const cli = path.resolve(__dirname, "..", "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.resolve(__dirname, "..", "..", "..", "..", "scripts", "geoip-database.ts");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, script, ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, GEOIP_DB_PATH: "" } });

  it("a failed install keeps the working database, exits non-zero and records the failure; a later good install records the success", () => {
    const current = database(T(2026, 10));
    writeFileSync(target, current);
    const bad = put("bad.mmdb", "half a download ".repeat(300));
    const failed = run("install", bad, "--target", target);
    expect(failed.status).toBe(1);
    expect(readFileSync(target).equals(current)).toBe(true);
    const status = JSON.parse(readFileSync(updateStatusPath(target), "utf8"));
    expect(status).toMatchObject({ lastOutcome: "failed", lastSuccessAt: null });
    expect(status.lastError).not.toContain(dir); // no path

    const good = database(T(2026, 11));
    const ok = run("install", put("good.mmdb", good), "--target", target);
    expect(ok.status).toBe(0);
    expect(readFileSync(target).equals(good)).toBe(true);
    expect(JSON.parse(readFileSync(updateStatusPath(target), "utf8"))).toMatchObject({ lastOutcome: "success", lastError: null });
    const shown = run("status", "--target", target);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toMatch(/Last update attempt: success/);
    expect(shown.stdout).toMatch(/Last successful update: 20\d\d-/);
  }, 90_000);

  it("download without the licence flag is a usage error: nothing is downloaded and nothing is recorded as an update attempt", () => {
    const r = run("download", "--target", target);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/CC BY 4\.0/);
    expect(existsSync(updateStatusPath(target))).toBe(false);
  }, 90_000);

  it("status on an empty location says so and changes nothing", () => {
    mkdirSync(path.join(dir, "empty"));
    const r = run("status", "--target", path.join(dir, "empty", "city.mmdb"));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not usable/);
    expect(r.stdout).toMatch(/no record/);
    expect(readdirSync(path.join(dir, "empty"))).toEqual([]);
  }, 90_000);
});

