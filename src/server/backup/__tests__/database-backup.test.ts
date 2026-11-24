// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKUP_TTL_MS,
  BackupError,
  backupStagingDir,
  buildPgEnvironment,
  createBackup,
  deleteStagedBackup,
  getBackupCapability,
  isValidBackupId,
  listStagedBackups,
  redactSecrets,
  resolveStagedBackup,
  runTool,
  sweepStagedBackups,
  type BackupDeps,
} from "../database-backup";

// The parts of the backup module that need no database and no PostgreSQL tools: names and paths, secrets handling, the staging area, locking, and how a tool is started. The real
// pg_dump / pg_restore round trip (backup, verify, restore into a new database, compare) is database-backup.integration.test.ts.
const root = mkdtempSync(path.join(tmpdir(), "backup-unit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PASSWORD = "s3cr3t-P@ss/word:with+odd@chars";
const URL_WITH_PASSWORD = `postgresql://compass_user:${encodeURIComponent(PASSWORD)}@db.internal:5432/compass_prod?sslmode=disable`;
const ID = "compass-20261124T101530Z-3fa9c2d1";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(root, "stage-"));
  vi.stubEnv("DATABASE_SSL_MODE", "");
  vi.stubEnv("DATABASE_SSL_CA", "");
  vi.stubEnv("DATABASE_SSL_VERIFY", "");
});
afterEach(() => vi.unstubAllEnvs());

/** A staged backup as createBackup leaves it: <id>.dump plus <id>.json. */
function stage(id = ID, over: Partial<{ size: number; sha: string; createdAt: Date; recordSize: number }> = {}) {
  const body = Buffer.alloc(over.size ?? 2048, 7);
  const createdAt = over.createdAt ?? new Date();
  writeFileSync(path.join(dir, `${id}.dump`), body);
  writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, fileName: `${id}.dump`, sizeBytes: over.recordSize ?? body.length, createdAt: createdAt.toISOString(), sha256: over.sha ?? "a".repeat(64), format: "PostgreSQL custom format", pgDumpVersion: "17.11", serverVersion: "17.11" })
  );
  return body;
}

describe("backup ids and the staging directory", () => {
  it("accepts exactly the names this module generates", () => {
    expect(isValidBackupId(ID)).toBe(true);
    expect(isValidBackupId("compass-20261124T101530Z-00000000")).toBe(true);
  });

  it.each([
    "", "../etc/passwd", "..\\..\\windows\\win.ini", `${ID}.dump`, `${ID}/../${ID}`, `${ID}\0`, `${ID} `, ` ${ID}`, "compass-20261124T101530Z-3FA9C2D1", "compass-20261124T101530Z-3fa9c2d", "compass-20261124T101530Z-3fa9c2d1x",
    "COMPASS-20261124T101530Z-3fa9c2d1", "compass-2026112T101530Z-3fa9c2d1", "/absolute/path", "C:\\x", "a".repeat(200), null, undefined, 123, {}, [ID],
  ])("refuses %j", (id) => {
    expect(isValidBackupId(id)).toBe(false);
  });

  it("uses BACKUP_STAGING_DIR when set, else a private folder under the system temp directory", () => {
    expect(backupStagingDir({ BACKUP_STAGING_DIR: dir })).toBe(path.resolve(dir));
    expect(backupStagingDir({ BACKUP_STAGING_DIR: "  " })).toBe(path.join(tmpdir(), "compass-tools-backups"));
    expect(backupStagingDir({})).toBe(path.join(tmpdir(), "compass-tools-backups"));
  });
});

describe("secrets never leave the module", () => {
  it("redactSecrets removes connection strings, password assignments and the given secret values, control characters and length", () => {
    const text = `could not connect to postgresql://u:${PASSWORD}@db/x and password=hunter2 PGPASSWORD: hunter3 value ${PASSWORD}\u0000\u0007`;
    const out = redactSecrets(text, [PASSWORD]);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("hunter3");
    expect(out).not.toMatch(/postgres(ql)?:\/\/u:/);
    expect(out).not.toMatch(/\p{Cc}/u);
    expect(redactSecrets("x".repeat(5000)).length).toBeLessThanOrEqual(300);
  });

  it("the libpq environment carries host, port, database, user and password as variables, decoded, and none of them is placed in anything an argument list could hold", async () => {
    const pg = await buildPgEnvironment(URL_WITH_PASSWORD);
    expect(pg.env).toMatchObject({ PGHOST: "db.internal", PGPORT: "5432", PGDATABASE: "compass_prod", PGUSER: "compass_user", PGPASSWORD: PASSWORD, PGSSLMODE: "require" });
    expect(pg.secrets).toEqual([PASSWORD]);
    await pg.cleanup();
  });

  it("does not hand the application's other secrets to the tool: only PATH-like variables and the PG* ones", async () => {
    vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "should-never-reach-the-child");
    vi.stubEnv("CARD_ENCRYPTION_KEY", "nor-this");
    const { env, cleanup } = await buildPgEnvironment(URL_WITH_PASSWORD);
    expect(Object.keys(env).every((k) => /^(PG[A-Z_]+|PATH|Path|HOME|SystemRoot|WINDIR|TEMP|TMP|TMPDIR|LANG)$/.test(k))).toBe(true);
    expect(JSON.stringify(env)).not.toMatch(/should-never-reach|nor-this/);
    await cleanup();
  });

  it("refuses a missing or unusable connection setting with a plain message that does not repeat it", async () => {
    for (const bad of [undefined, "", "not a url", "mysql://u:p@h/db", "postgresql://u:p@/db", "postgresql://u:p@host/"]) {
      const error = await buildPgEnvironment(bad).catch((e) => e);
      expect(error).toBeInstanceOf(BackupError);
      expect((error as BackupError).code).toBe("NOT_CONFIGURED");
      expect((error as BackupError).message).not.toMatch(/mysql|u:p/);
    }
  });

  it("follows the application's own TLS decision: disabled, system roots, a pinned CA (written to a private temporary file that cleanup removes), or encrypted-unverified", async () => {
    const disabled = await buildPgEnvironment("postgresql://u:p@127.0.0.1:5432/db", { DATABASE_SSL_MODE: "disable" });
    expect(disabled.env.PGSSLMODE).toBe("disable");
    const system = await buildPgEnvironment("postgresql://u:p@db.example.com:5432/db", { DATABASE_SSL_VERIFY: "system" });
    expect(system.env.PGSSLMODE).toBe("verify-full");
    const pem = "-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----";
    const ca = await buildPgEnvironment("postgresql://u:p@db.example.com:5432/db", { DATABASE_SSL_CA: pem });
    expect(ca.env.PGSSLMODE).toBe("verify-full");
    const file = ca.env.PGSSLROOTCERT!;
    expect(readFileSync(file, "utf8")).toContain("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----");
    await ca.cleanup();
    expect(existsSync(file)).toBe(false);
    const plain = await buildPgEnvironment("postgresql://u:p@db.example.com:5432/db", {});
    expect(plain.env.PGSSLMODE).toBe("require");
  });
});

describe("the staging area", () => {
  it("lists staged backups newest first, from their records, and hides files that are not backups", async () => {
    stage("compass-20261124T100000Z-aaaaaaaa", { createdAt: new Date(Date.now() - 20 * 60_000) });
    stage("compass-20261124T110000Z-bbbbbbbb", { createdAt: new Date(Date.now() - 5 * 60_000) });
    writeFileSync(path.join(dir, "notes.txt"), "x");
    writeFileSync(path.join(dir, "compass-bad.dump"), "x");
    writeFileSync(path.join(dir, "stranger.dump"), "x");
    const list = await listStagedBackups({ env: { BACKUP_STAGING_DIR: dir } });
    expect(list.map((b) => b.id)).toEqual(["compass-20261124T110000Z-bbbbbbbb", "compass-20261124T100000Z-aaaaaaaa"]);
    expect(list[0]).toMatchObject({ fileName: "compass-20261124T110000Z-bbbbbbbb.dump", sizeBytes: 2048, sha256: "a".repeat(64) });
  });

  it("does not list a file whose record is missing, malformed, or disagrees with the file (a replaced or truncated dump)", async () => {
    stage("compass-20261124T100000Z-aaaaaaaa", { recordSize: 999 });
    writeFileSync(path.join(dir, "compass-20261124T100100Z-bbbbbbbb.dump"), "x");
    stage("compass-20261124T100200Z-cccccccc", { sha: "not-hex" });
    expect(await listStagedBackups({ env: { BACKUP_STAGING_DIR: dir } })).toEqual([]);
  });

  it("an expired backup is neither listed nor downloadable, and the sweep removes its files", async () => {
    stage(ID, { createdAt: new Date(Date.now() - BACKUP_TTL_MS - 60_000) });
    const old = new Date(Date.now() - BACKUP_TTL_MS - 60_000);
    utimesSync(path.join(dir, `${ID}.dump`), old, old);
    utimesSync(path.join(dir, `${ID}.json`), old, old);
    const env = { BACKUP_STAGING_DIR: dir };
    expect(await listStagedBackups({ env })).toEqual([]);
    await expect(resolveStagedBackup(ID, { env })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("the sweep removes an abandoned .partial but never an unrelated file", async () => {
    writeFileSync(path.join(dir, `${ID}.dump.partial`), "half");
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(path.join(dir, `${ID}.dump.partial`), old, old);
    writeFileSync(path.join(dir, "someone-elses-file.txt"), "keep");
    utimesSync(path.join(dir, "someone-elses-file.txt"), old, old);
    expect(await sweepStagedBackups({ env: { BACKUP_STAGING_DIR: dir } })).toBe(1);
    expect(readdirSync(dir)).toEqual(["someone-elses-file.txt"]);
  });

  it("resolves a valid staged backup to its file; anything else - a traversal, an unknown id, a symlink - is NOT_FOUND", async () => {
    stage();
    const env = { BACKUP_STAGING_DIR: dir };
    const ok = await resolveStagedBackup(ID, { env });
    expect(ok.path).toBe(path.join(dir, `${ID}.dump`));
    expect(ok.info.id).toBe(ID);
    for (const bad of ["../x", `${ID}/..`, "compass-20261124T101530Z-ffffffff", "", undefined, 5]) {
      await expect(resolveStagedBackup(bad, { env }), String(bad)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    // a symlink in the staging area pointing at a file outside it is refused (it would let a download read anything the application can read)
    const outside = path.join(root, "outside-secret.txt");
    writeFileSync(outside, "secret");
    const linked = "compass-20261124T101531Z-11111111";
    writeFileSync(path.join(dir, `${linked}.json`), JSON.stringify({ id: linked, sizeBytes: 6, createdAt: new Date().toISOString(), sha256: "b".repeat(64) }));
    try {
      symlinkSync(outside, path.join(dir, `${linked}.dump`));
    } catch {
      return; // creating a symlink needs a privilege on some Windows setups; the check above already covers the logic path
    }
    await expect(resolveStagedBackup(linked, { env })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await listStagedBackups({ env })).toHaveLength(1); // only the real one
  });

  it("deleting removes the file and its record, and only for a valid id", async () => {
    stage();
    const env = { BACKUP_STAGING_DIR: dir };
    expect(await deleteStagedBackup("../x", { env })).toBe(false);
    expect(await deleteStagedBackup(ID, { env })).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(await deleteStagedBackup(ID, { env })).toBe(false);
  });
});

describe("how a tool is started", () => {
  it("never through a shell: an argument full of shell syntax arrives as one literal argument", async () => {
    const hostile = 'a; echo INJECTED && whoami | cat > pwned.txt $(id) `id` "quoted" \'single\' %PATH%';
    const r = await runTool(process.execPath, ["-e", "process.stdout.write(process.argv[1])", hostile], { env: { PATH: process.env.PATH }, timeoutMs: 20_000, cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(hostile);
    expect(existsSync(path.join(dir, "pwned.txt"))).toBe(false);
  });

  it("stops a tool that runs too long", async () => {
    const started = Date.now();
    const r = await runTool(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { env: { PATH: process.env.PATH }, timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("a tool that does not exist is a spawn error, not a crash", async () => {
    const r = await runTool(path.join(root, "no-such-tool"), [], { env: { PATH: process.env.PATH }, timeoutMs: 5_000 });
    expect(r.spawnError).toBeDefined();
  });

  it("does not pass the application's environment to the tool", async () => {
    vi.stubEnv("SECRET_FOR_TEST", "must-not-leak");
    const r = await runTool(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).filter(k => /SECRET|KEY/.test(k))))"], { env: { PATH: process.env.PATH }, timeoutMs: 20_000 });
    expect(r.stdout).toBe("[]");
  });
});

describe("whether a backup can be made here", () => {
  const server = (serverVersion: string, sizeBytes = 1000): BackupDeps => ({ databaseFacts: async () => ({ serverVersion, sizeBytes }), freeBytes: async () => 10 ** 12 });

  it("a missing tool is reported plainly (TOOL_MISSING), never thrown", async () => {
    const cap = await getBackupCapability({ env: { PG_DUMP_BIN: path.join(root, "no-such-pg_dump") }, deps: server("17.11") });
    expect(cap).toMatchObject({ available: false, code: "TOOL_MISSING" });
  });

  it("a tool OLDER than the server is refused (pg_dump cannot dump a newer server); an equal or newer one is fine", async () => {
    // node stands in for pg_dump here: it answers --version with a number the module reads as a major version
    const cap = await getBackupCapability({ env: { PG_DUMP_BIN: process.execPath }, deps: server("99.1") });
    expect(cap).toMatchObject({ available: false, code: "VERSION_MISMATCH" });
    const ok = await getBackupCapability({ env: { PG_DUMP_BIN: process.execPath }, deps: server("17.11") });
    expect(ok.available).toBe(true);
  });

  it("a failure while asking the database is 'not available', never an exception", async () => {
    const cap = await getBackupCapability({ env: { PG_DUMP_BIN: process.execPath }, deps: { databaseFacts: async () => { throw new Error("db down"); }, freeBytes: async () => 1 } });
    expect(cap.available).toBe(false);
  });
});

describe("createBackup - refusals that must leave nothing behind (node stands in for the PostgreSQL tools)", () => {
  const deps = (over: Partial<BackupDeps> = {}): BackupDeps => ({ databaseFacts: async () => ({ serverVersion: "17.11", sizeBytes: 5_000 }), freeBytes: async () => 10 ** 12, ...over });
  const env = () => ({ DATABASE_URL: URL_WITH_PASSWORD, BACKUP_STAGING_DIR: dir, PG_DUMP_BIN: process.execPath, PG_RESTORE_BIN: process.execPath });

  it("not configured: refused before anything is created", async () => {
    await expect(createBackup({ env: { BACKUP_STAGING_DIR: dir } })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("not enough free disk: refused with the numbers, before pg_dump runs, nothing left behind", async () => {
    const error = await createBackup({ env: env(), deps: deps({ freeBytes: async () => 1024 * 1024 }) }).catch((e) => e);
    expect(error).toMatchObject({ code: "INSUFFICIENT_DISK" });
    expect(error.message).toMatch(/MB are needed and 1 MB are free/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a failing dump (the tool exits with an error): DUMP_FAILED, no partial file, no lock, and the message holds no credential", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.join(" ")));
    const error = await createBackup({ env: env(), deps: deps() }).catch((e) => e);
    spy.mockRestore();
    expect(error).toBeInstanceOf(BackupError);
    expect(error.code).toBe("DUMP_FAILED");
    expect(error.message).not.toContain(PASSWORD);
    expect(logged.join("\n")).not.toContain(PASSWORD);
    expect(logged.join("\n")).not.toMatch(/postgres(ql)?:\/\/compass_user/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("only one backup at a time: a fresh lock refuses, and is left alone; a lock from a crashed run (older than the timeout) is cleared", async () => {
    const lock = path.join(dir, "backup.lock");
    writeFileSync(lock, "{}");
    await expect(createBackup({ env: env(), deps: deps() })).rejects.toMatchObject({ code: "ALREADY_RUNNING" });
    expect(existsSync(lock)).toBe(true);
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(lock, old, old);
    await expect(createBackup({ env: env(), deps: deps() })).rejects.toMatchObject({ code: "DUMP_FAILED" }); // got past the lock, then the stand-in tool failed
    expect(existsSync(lock)).toBe(false);
  });

  it("the staging directory is created private (0700 where the platform has modes) and holds nothing after a refusal", async () => {
    const fresh = path.join(root, "fresh-stage");
    mkdirSync(path.join(root), { recursive: true });
    await expect(createBackup({ env: { ...env(), BACKUP_STAGING_DIR: fresh }, deps: deps({ freeBytes: async () => 0 }) })).rejects.toMatchObject({ code: "INSUFFICIENT_DISK" });
    expect(existsSync(fresh)).toBe(true);
    expect(readdirSync(fresh)).toEqual([]);
    if (process.platform !== "win32") expect((statSync(fresh).mode & 0o777).toString(8)).toBe("700");
  });
});
