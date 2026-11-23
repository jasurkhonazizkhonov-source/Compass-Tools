import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Source-level review of migration 20261123000100_lead_date_flexibility_days. NOTHING here runs a migration or touches a database: it reads the SQL, the Prisma schema and the
// manifest as text. It cannot prove how PostgreSQL applies the file (that is what the CI database job does on a throw-away server).
const root = process.cwd();
const dir = "20261123000100_lead_date_flexibility_days";
const sql = fs.readFileSync(path.join(root, "prisma", "migrations", dir, "migration.sql"), "utf8");
const statements = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

describe("the migration file", () => {
  it("is exactly two additive statements: one nullable column with no default, and a CHECK that keeps it NULL or 0-3", () => {
    expect(statements).toEqual([
      `ALTER TABLE "Lead" ADD COLUMN "dateFlexibilityDays" INTEGER`,
      `ALTER TABLE "Lead" ADD CONSTRAINT "Lead_dateFlexibilityDays_range" CHECK ("dateFlexibilityDays" IS NULL OR ("dateFlexibilityDays" >= 0 AND "dateFlexibilityDays" <= 3))`,
    ]);
  });

  it("reads, rewrites and deletes nothing: no UPDATE / DELETE / DROP / RENAME / TRUNCATE / INSERT, no NOT NULL and no DEFAULT (so no existing row is rewritten)", () => {
    expect(statements.join(";")).not.toMatch(/\b(UPDATE|DELETE|DROP|RENAME|TRUNCATE|INSERT|NOT\s+NULL|DEFAULT)\b/i);
  });

  it("starts with no byte-order mark, is listed in the manifest (which stays sorted), and the schema declares the same nullable column beside the untouched Boolean", () => {
    expect(fs.readFileSync(path.join(root, "prisma", "migrations", dir, "migration.sql"))[0]).not.toBe(0xef);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "src", "lib", "migration-manifest.json"), "utf8")) as { migrations: string[] };
    expect(manifest.migrations).toContain(dir);
    expect([...manifest.migrations].sort()).toEqual(manifest.migrations);
    const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
    const lead = /model Lead \{([\s\S]*?)\n\}/.exec(schema)![1];
    expect(lead).toMatch(/dateFlexibilityDays\s+Int\?/);
    expect(lead).toMatch(/flexibleDates\s+Boolean\s+@default\(false\)/);
  });
});
