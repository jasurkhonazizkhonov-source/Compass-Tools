import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Source-level review of migration 20261122000200_marketing_send_cancelled_status. NOTHING here runs a migration or touches a database: it reads the SQL, the Prisma schema and
// the manifest as text. It cannot prove how PostgreSQL applies the file (that is what the CI database job does on a throw-away server).

const root = process.cwd();
const dir = "20261122000200_marketing_send_cancelled_status";
const sqlPath = path.join(root, "prisma", "migrations", dir, "migration.sql");
const sql = fs.readFileSync(sqlPath, "utf8");
const statements = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

describe("the migration file", () => {
  it("is exactly one additive statement: a new label on the existing MarketingSendStatus enum", () => {
    expect(statements).toEqual([`ALTER TYPE "MarketingSendStatus" ADD VALUE IF NOT EXISTS 'CANCELLED'`]);
  });

  it("reads, rewrites and deletes nothing: no UPDATE / DELETE / DROP / RENAME / TRUNCATE / INSERT, no new column, no change to another type", () => {
    expect(statements.join(";")).not.toMatch(/\b(UPDATE|DELETE|DROP|RENAME|TRUNCATE|INSERT|ADD\s+COLUMN|ALTER\s+TABLE)\b/i);
  });

  it("starts with no byte-order mark and is the newest entry of the manifest, which stays sorted", () => {
    expect(fs.readFileSync(sqlPath)[0]).not.toBe(0xef);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "src", "lib", "migration-manifest.json"), "utf8")) as { migrations: string[] };
    expect(manifest.migrations).toContain(dir);
    expect([...manifest.migrations].sort()).toEqual(manifest.migrations);
    expect(manifest.migrations.at(-1)).toBe(dir);
    expect(fs.readdirSync(path.join(root, "prisma", "migrations")).filter((d) => d.startsWith("2026")).sort().at(-1)).toBe(dir);
  });

  it("the schema declares exactly the new label, last, so the generated client and the database agree", () => {
    const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
    const block = /enum MarketingSendStatus \{([\s\S]*?)\}/.exec(schema)![1];
    const labels = block.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//") && !l.startsWith("///"));
    expect(labels).toEqual(["PENDING", "SENT", "FAILED", "SKIPPED_UNSUBSCRIBED", "SKIPPED_SUPPRESSED", "UNKNOWN", "CANCELLED"]);
  });

  it("the worker can only ever claim PENDING rows, so a CANCELLED recipient can never be sent (source check of the claim)", () => {
    const worker = fs.readFileSync(path.join(root, "src", "server", "marketing", "campaign-worker.ts"), "utf8");
    expect(worker).toMatch(/where: \{ id: row\.id, status: "PENDING", attempts: row\.attempts \}/); // the compare-and-swap
    expect(worker).toMatch(/where: \{ campaignId, status: "PENDING", OR:/); // the batch it selects
    expect(worker).not.toMatch(/status: "CANCELLED"/); // the worker never writes or selects it
  });
});
