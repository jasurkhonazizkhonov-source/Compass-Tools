import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canEditContactDetails } from "../permissions";

// Source-level review of migration 20261115000100_account_contact_detail_edit_permission. NOTHING here runs a migration or touches a database: it reads the
// SQL, the Prisma schema and the manifest as text and checks the permission rule as code. It cannot prove how PostgreSQL applies the file.

const root = process.cwd();
const dir = "20261115000100_account_contact_detail_edit_permission";
const sql = fs.readFileSync(path.join(root, "prisma", "migrations", dir, "migration.sql"), "utf8");
const statements = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

describe("the migration file", () => {
  it("is exactly one additive statement: ADD COLUMN ... BOOLEAN NOT NULL DEFAULT true on Account", () => {
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^ALTER TABLE "Account" ADD COLUMN "canEditContactDetails" BOOLEAN NOT NULL DEFAULT true$/);
  });

  it("changes no existing data and no other column: no UPDATE, DELETE, DROP, RENAME, ALTER COLUMN, TRUNCATE or role/permission-array change", () => {
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|RENAME|TRUNCATE|ALTER\s+COLUMN)\b/i);
    expect(sql).not.toMatch(/"role"|paymentPermissions|bookingPermissions|activeSessionId/);
  });

  it("starts with no byte-order mark and is listed, in order and last-but-newer migrations aside, in the manifest", () => {
    const bytes = fs.readFileSync(path.join(root, "prisma", "migrations", dir, "migration.sql"));
    expect(bytes[0]).not.toBe(0xef);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "src", "lib", "migration-manifest.json"), "utf8")) as { migrations: string[] };
    expect(manifest.migrations).toContain(dir);
    expect([...manifest.migrations].sort()).toEqual(manifest.migrations);
  });

  it("the Prisma schema matches the migration (same column, type and default), so the migration is the only thing that creates it", () => {
    const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
    expect(schema).toMatch(/canEditContactDetails\s+Boolean\s+@default\(true\)/);
  });
});

describe("the permission rule the migration feeds (no accidental grant, no accidental removal)", () => {
  const ROLES = ["ADMIN", "MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const;

  it("after migration every existing row has the default (true), so every user keeps exactly the ability they had before - nobody gains or loses access", () => {
    for (const role of ROLES) expect(canEditContactDetails({ role, canEditContactDetails: true })).toBe(true);
  });

  it("an Administrator is never restricted, whatever the column says (so an Admin can always manage the setting and the data)", () => {
    expect(canEditContactDetails({ role: "ADMIN", canEditContactDetails: false })).toBe(true);
    expect(canEditContactDetails({ role: "ADMIN" })).toBe(true);
  });

  it("an explicit false denies every non-admin role", () => {
    for (const role of ROLES.filter((r) => r !== "ADMIN")) expect(canEditContactDetails({ role, canEditContactDetails: false })).toBe(false);
  });

  it("a missing or null value is DENIED for non-admins (fails closed): an account object that does not carry the column can never be granted by accident", () => {
    for (const role of ROLES.filter((r) => r !== "ADMIN")) {
      expect(canEditContactDetails({ role })).toBe(false);
      expect(canEditContactDetails({ role, canEditContactDetails: undefined })).toBe(false);
      expect(canEditContactDetails({ role, canEditContactDetails: null as unknown as boolean })).toBe(false);
    }
    expect(canEditContactDetails(null)).toBe(false);
    expect(canEditContactDetails(undefined)).toBe(false);
  });
});
