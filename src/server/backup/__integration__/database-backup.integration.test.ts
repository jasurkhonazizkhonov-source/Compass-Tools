// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { BACKUP_EXCLUDED_DATA, BackupError, buildPgEnvironment, createBackup, getBackupCapability, listStagedBackups, resolveStagedBackup, runTool, type BackupDeps } from "../database-backup";

// REAL-DATABASE proof of the backup AND of restoring it, with PostgreSQL's own pg_dump / pg_restore:
//   1. a backup of a real database is created, verified, hashed and staged;
//   2. it is restored into a NEW, separate database, exactly as the recovery guide says;
//   3. the restored database matches the original (every table's rows, the migration history, indexes, constraints, sequences) and is accepted by Prisma as an up-to-date schema;
//   4. the stored security codes are really absent, credentials never appear anywhere, concurrent backups are refused, a failing dump leaves nothing behind.
// Runs only when INTEGRATION_DATABASE_URL (the disposable local database) AND PG_DUMP_BIN / PG_RESTORE_BIN (PostgreSQL client tools of at least the server's major version) are set; it
// is skipped, and says so, otherwise. It touches only the disposable database and a scratch database it creates and drops itself (INTEGRATION_ADMIN_DATABASE_URL).

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const ADMIN_URL = process.env.INTEGRATION_ADMIN_DATABASE_URL;
const DUMP = process.env.PG_DUMP_BIN;
const RESTORE = process.env.PG_RESTORE_BIN;
const enabled = !!URL_UNDER_TEST && !!ADMIN_URL && !!DUMP && !!RESTORE;

const root = mkdtempSync(path.join(tmpdir(), "backup-it-"));
const stagingDir = path.join(root, "stage");
const TAG = `bk${Date.now()}`;
const RESTORED_DB = `compass_restore_${Date.now()}`;

const connect = async (url: string, database?: string) => {
  const u = new URL(url);
  const client = new Client({ host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: database ?? u.pathname.slice(1), ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
};
const urlFor = (database: string) => {
  const u = new URL(URL_UNDER_TEST!);
  u.pathname = `/${database}`;
  return u.toString();
};

const env = (over: Record<string, string> = {}) => ({ DATABASE_URL: URL_UNDER_TEST!, BACKUP_STAGING_DIR: stagingDir, PG_DUMP_BIN: DUMP, PG_RESTORE_BIN: RESTORE, ...over });
const deps = async (): Promise<BackupDeps> => ({
  databaseFacts: async () => {
    const c = await connect(URL_UNDER_TEST!);
    try {
      const r = await c.query("SELECT current_setting('server_version') AS v, pg_database_size(current_database()) AS s");
      return { serverVersion: r.rows[0].v, sizeBytes: Number(r.rows[0].s) };
    } finally {
      await c.end();
    }
  },
  freeBytes: async () => 10 ** 13,
});

describe.skipIf(!enabled)("database backup and restore against a real PostgreSQL", () => {
  let source: Client;
  let admin: Client;
  let backupId = "";
  let backupPath = "";

  beforeAll(async () => {
    source = await connect(URL_UNDER_TEST!);
    admin = await connect(ADMIN_URL!);
    // A table of the test's own, with data that is awkward to dump: quotes, newlines, unicode, a large text, a sequence that has been advanced, an index and a constraint.
    await source.query(`DROP TABLE IF EXISTS "${TAG}_probe"`);
    await source.query(`CREATE TABLE "${TAG}_probe" (id serial PRIMARY KEY, note text NOT NULL, body text, CONSTRAINT "${TAG}_note_len" CHECK (length(note) > 0))`);
    await source.query(`CREATE INDEX "${TAG}_note_idx" ON "${TAG}_probe" (note)`);
    await source.query(`INSERT INTO "${TAG}_probe"(note, body) SELECT 'row ' || g || ' it''s "quoted" ünïcödé 😀 ' || E'\\n' || 'line2', repeat('x', 5000) FROM generate_series(1, 400) g`);
    await source.query(`SELECT setval(pg_get_serial_sequence('"${TAG}_probe"', 'id'), 1000)`);
  }, 60_000);

  afterAll(async () => {
    await source?.query(`DROP TABLE IF EXISTS "${TAG}_probe"`).catch(() => undefined);
    await admin?.query(`DROP DATABASE IF EXISTS "${RESTORED_DB}" WITH (FORCE)`).catch(() => undefined);
    await source?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("the tools are available and not older than the server", async () => {
    const cap = await getBackupCapability({ env: env(), deps: await deps() });
    expect(cap, JSON.stringify(cap)).toMatchObject({ available: true });
  });

  it("creates a verified, hashed, private backup file with the generated name, and stages it for download", async () => {
    const info = await createBackup({ env: env(), deps: await deps() });
    backupId = info.id;
    backupPath = path.join(stagingDir, info.fileName);
    expect(info.id).toMatch(/^compass-\d{8}T\d{6}Z-[a-f0-9]{8}$/);
    expect(info.fileName).toBe(`${info.id}.dump`);
    expect(info.format).toMatch(/custom format/);
    expect(info.sizeBytes).toBe(statSync(backupPath).size);
    expect(info.sizeBytes).toBeGreaterThan(10_000);
    expect(info.sha256).toMatch(/^[a-f0-9]{64}$/);
    // a custom-format dump starts with the "PGDMP" magic: it is a genuine pg_dump archive, not text and not an export
    expect(readFileSync(backupPath).subarray(0, 5).toString("latin1")).toBe("PGDMP");
    // nothing temporary and no lock is left; only the dump and its record
    expect(readdirSync(stagingDir).sort()).toEqual([`${info.id}.dump`, `${info.id}.json`]);
    expect((await listStagedBackups({ env: env() })).map((b) => b.id)).toEqual([info.id]);
    expect((await resolveStagedBackup(info.id, { env: env() })).path).toBe(backupPath);
    if (process.platform !== "win32") expect(statSync(backupPath).mode & 0o777).toBe(0o600);
  }, 180_000);

  it("the dump's table of contents has the CRM's tables and migration history, and the stored security codes' DATA is excluded", async () => {
    const r = spawnSync(RESTORE!, ["--list", backupPath], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\sTABLE public Account\s/);
    expect(r.stdout).toMatch(/\sTABLE public Lead\s/);
    expect(r.stdout).toMatch(/\sTABLE public _prisma_migrations\s/);
    expect(r.stdout).toMatch(/\sTABLE DATA public Account\s/);
    expect(r.stdout).toMatch(new RegExp(`\\sTABLE public ${BACKUP_EXCLUDED_DATA}\\s`)); // the table itself (structure) is there...
    expect(r.stdout).not.toMatch(new RegExp(`\\sTABLE DATA public ${BACKUP_EXCLUDED_DATA}\\s`)); // ...its data is not
  });

  it("RESTORE: the backup restores into a NEW database, which matches the original table by table (rows), index, constraint and sequence, and Prisma accepts its schema as current", async () => {
    // exactly the procedure of the recovery guide: a new empty database, then pg_restore into it
    await admin.query(`CREATE DATABASE "${RESTORED_DB}" ENCODING 'UTF8' TEMPLATE template0`);
    const pg = await buildPgEnvironment(urlFor(RESTORED_DB), {});
    const restored = await runTool(RESTORE!, ["--no-owner", "--no-privileges", "--exit-on-error", `--dbname=${RESTORED_DB}`, backupPath], { env: pg.env, timeoutMs: 300_000 });
    await pg.cleanup();
    expect(restored.code, restored.stderr).toBe(0);

    const target = await connect(urlFor(RESTORED_DB));
    try {
      const tables = (await source.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename as string);
      expect(tables.length).toBeGreaterThan(40);
      const restoredTables = (await target.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename as string);
      expect(restoredTables).toEqual(tables);
      for (const t of tables) {
        const a = await source.query(`SELECT count(*)::int AS n FROM "${t}"`);
        const b = await target.query(`SELECT count(*)::int AS n FROM "${t}"`);
        expect(b.rows[0].n, `rows in ${t}`).toBe(a.rows[0].n);
      }
      // the migration history is intact (Prisma's own table)
      const history = (c: Client) => c.query(`SELECT migration_name, finished_at IS NOT NULL AS done FROM _prisma_migrations ORDER BY migration_name`);
      expect((await history(target)).rows).toEqual((await history(source)).rows);
      // the test table: content byte for byte, awkward characters included
      const sample = (c: Client) => c.query(`SELECT id, note, md5(body) AS h FROM "${TAG}_probe" ORDER BY id`);
      const [srcRows, dstRows] = [await sample(source), await sample(target)];
      expect(dstRows.rows).toEqual(srcRows.rows);
      expect(dstRows.rows[0].note).toContain("ünïcödé 😀");
      // structure: indexes and constraints are present and identical in definition; the sequence continues where it was
      const idx = (c: Client) => c.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`);
      expect((await idx(target)).rows).toEqual((await idx(source)).rows);
      const cons = (c: Client) => c.query(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`);
      expect((await cons(target)).rows).toEqual((await cons(source)).rows);
      const next = await target.query(`INSERT INTO "${TAG}_probe"(note) VALUES ('after restore') RETURNING id`);
      expect(next.rows[0].id).toBe(1001);
      await expect(target.query(`INSERT INTO "${TAG}_probe"(note) VALUES ('')`)).rejects.toThrow(/check constraint/);
    } finally {
      await target.end();
    }

    // the application's own view of it: Prisma finds the database's migration history complete and the schema current
    const prisma = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["prisma", "migrate", "status"], {
      cwd: path.resolve(__dirname, "..", "..", "..", ".."),
      env: { ...process.env, DATABASE_URL: urlFor(RESTORED_DB) },
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 120_000,
    });
    expect(prisma.stdout + prisma.stderr).toMatch(/Database schema is up to date!/);
  }, 600_000);

  it("a second backup while one is running is refused, and the one that ran is intact", async () => {
    const d = await deps();
    const results = await Promise.allSettled([createBackup({ env: env(), deps: d }), createBackup({ env: env(), deps: d })]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of refused) expect((r.reason as BackupError).code).toBe("ALREADY_RUNNING");
    expect(existsSync(path.join(stagingDir, "backup.lock"))).toBe(false);
    expect(readdirSync(stagingDir).filter((f) => f.endsWith(".partial"))).toEqual([]);
  }, 300_000);

  it("a dump that cannot connect (wrong password) fails cleanly: DUMP_FAILED, nothing left behind, and neither the password nor a connection string reaches the message or the log", async () => {
    const before = readdirSync(stagingDir).sort();
    const u = new URL(URL_UNDER_TEST!);
    u.password = "definitely-wrong-Pa55/w0rd";
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => void logged.push(a.join(" ")));
    const error = await createBackup({ env: env({ DATABASE_URL: u.toString() }), deps: await deps() }).catch((e) => e);
    spy.mockRestore();
    expect(error).toBeInstanceOf(BackupError);
    expect(error.code).toBe("DUMP_FAILED");
    const everything = `${error.message}\n${logged.join("\n")}`;
    expect(everything).not.toContain("definitely-wrong");
    expect(everything).not.toMatch(/postgres(ql)?:\/\//);
    expect(readdirSync(stagingDir).sort()).toEqual(before);
  }, 120_000);

  it("a dump that cannot be read back is refused and removed (pg_restore stood in for by a program that fails)", async () => {
    const before = readdirSync(stagingDir).sort();
    const error = await createBackup({ env: env({ PG_RESTORE_BIN: process.execPath }), deps: await deps() }).catch((e) => e);
    expect(error).toMatchObject({ code: "VERIFY_FAILED" });
    expect(readdirSync(stagingDir).sort()).toEqual(before);
  }, 180_000);

  it("a dump stopped by the time limit leaves nothing and says so", async () => {
    const before = readdirSync(stagingDir).sort();
    const error = await createBackup({ env: env(), deps: await deps(), timeoutMs: 1 }).catch((e) => e);
    expect(error).toMatchObject({ code: "TIMEOUT" });
    expect(readdirSync(stagingDir).sort()).toEqual(before);
  }, 120_000);

  it("the backup id used in the download is the file name stem and never a path", () => {
    expect(backupId).not.toMatch(/[\\/]/);
    expect(path.basename(backupPath)).toBe(`${backupId}.dump`);
  });
});

if (!enabled) {
  describe("database backup integration (skipped)", () => {
    it.skip("needs INTEGRATION_DATABASE_URL, INTEGRATION_ADMIN_DATABASE_URL, PG_DUMP_BIN and PG_RESTORE_BIN (PostgreSQL client tools of at least the server's major version)", () => undefined);
  });
}
