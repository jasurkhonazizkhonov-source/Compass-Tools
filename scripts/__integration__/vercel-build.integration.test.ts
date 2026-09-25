// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";

// REAL-DATABASE tests of the deploy-time schema recovery logic in
// scripts/vercel-build.mjs. They create and DROP their own scratch database
// (named below) on the server at INTEGRATION_ADMIN_DATABASE_URL, and run the
// real `prisma migrate deploy` (all migrations, ~30-40s on a fresh DB).
// Skipped unless that variable is set; NEVER point it at a server whose
// databases you care about:
//
//   INTEGRATION_ADMIN_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres \
//     npx vitest run scripts/__integration__
//
// This is the test that exists because the unit tests (which stub the
// database) could not notice that the gate could never actually connect on a
// real server (it imported TypeScript that bare Node cannot load).

const ADMIN_URL = process.env.INTEGRATION_ADMIN_DATABASE_URL;
const enabled = !!ADMIN_URL;
const DB = `recovery_it_${Date.now()}`;
const urlFor = (db: string) => {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${db}`;
  return u.toString();
};

async function withClient<T>(db: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor(db), ssl: process.env.INTEGRATION_SSL === "1" ? { rejectUnauthorized: false } : false });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const rows = (db: string, sql: string) => withClient(db, async (c) => (await c.query(sql)).rows);
const tableCount = async () => Number((await rows(DB, "select count(*)::int c from information_schema.tables where table_schema='public'"))[0].c);

let tryInitializeDatabase: () => Promise<void>;
async function run(env: Record<string, string> = {}) {
  process.env.DATABASE_URL = urlFor(DB);
  delete process.env.DATABASE_AUTO_INIT;
  Object.assign(process.env, env);
  const warnings: string[] = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation((...a) => void warnings.push(a.join(" ")));
  try {
    await tryInitializeDatabase();
  } finally {
    vi.restoreAllMocks();
  }
  return warnings.join("\n");
}

describe.skipIf(!enabled)("scripts/vercel-build.mjs against a real PostgreSQL server", () => {
  beforeAll(async () => {
    ({ tryInitializeDatabase } = await import("../vercel-build.mjs"));
    await withClient("postgres", async (c) => {
      await c.query(`CREATE DATABASE ${DB} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    });
  });
  afterAll(async () => {
    if (!enabled) return;
    await withClient("postgres", async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    });
  });

  it("A/D: an EMPTY database is left completely untouched unless DATABASE_AUTO_INIT=true", async () => {
    const warnings = await run();
    expect(warnings).toMatch(/looks empty|no existing Company table/i);
    expect(await tableCount()).toBe(0);
  }, 60_000);

  it("A/D: an EMPTY database with DATABASE_AUTO_INIT=true is initialized by applying every migration", async () => {
    await run({ DATABASE_AUTO_INIT: "true" });
    expect(await tableCount()).toBeGreaterThan(30);
    const applied = Number((await rows(DB, "select count(*)::int c from _prisma_migrations where finished_at is not null"))[0].c);
    expect(applied).toBeGreaterThan(50);
    expect((await rows(DB, `select to_regclass('public."Company"') is not null as t`))[0].t).toBe(true);
  }, 240_000);

  it("B: an EXISTING migrated database with data is a no-op — nothing is dropped or changed", async () => {
    await rows(DB, `insert into "Company"(id,name,"signatureTemplate","updatedAt") values ('keep-co','Keep Me','x',now())`);
    const before = (await rows(DB, `select (select count(*) from "Company")::int c, (select count(*) from _prisma_migrations)::int m`))[0];

    await run();

    const after = (await rows(DB, `select (select count(*) from "Company")::int c, (select count(*) from _prisma_migrations)::int m`))[0];
    expect(after).toEqual(before);
    expect((await rows(DB, `select name from "Company" where id='keep-co'`))[0].name).toBe("Keep Me");
  }, 120_000);

  it("C: a PARTIALLY migrated database gets ONLY its missing migration; existing data survives", async () => {
    await rows(DB, `drop table "RateLimitCounter"`);
    await rows(DB, `delete from _prisma_migrations where migration_name like '%rate_limit_counter'`);

    await run();

    expect((await rows(DB, `select to_regclass('public."RateLimitCounter"') is not null as t`))[0].t).toBe(true);
    expect((await rows(DB, `select name from "Company" where id='keep-co'`))[0].name).toBe("Keep Me");
  }, 120_000);

  it("a FAILING migration is reported loudly with detail, does not block the build, and drops nothing", async () => {
    await rows(DB, `drop table "RateLimitCounter"`);
    await rows(DB, `delete from _prisma_migrations where migration_name like '%rate_limit_counter'`);
    await rows(DB, `create table "RateLimitCounter"(conflicting int)`); // collides with that migration's CREATE TABLE

    const warnings = await run(); // must resolve, not throw

    expect(warnings).toMatch(/migrate deploy did not complete/i);
    expect((await rows(DB, `select column_name from information_schema.columns where table_name='RateLimitCounter'`)).map((r) => r.column_name)).toEqual(["conflicting"]);
    expect((await rows(DB, `select name from "Company" where id='keep-co'`))[0].name).toBe("Keep Me");
  }, 120_000);
});
