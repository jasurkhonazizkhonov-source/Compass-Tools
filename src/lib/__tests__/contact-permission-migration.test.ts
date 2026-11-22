import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canEditContactDetails } from "../permissions";

// Source-level review of migration 20261115000100_account_contact_detail_edit_permission (adds the column, default true so nobody lost an ability) and of
// 20261122000100_account_contact_detail_edit_default_off (changes only the default for NEW rows to false). NOTHING here runs a migration or touches a database:
// it reads the SQL, the Prisma schema and the manifest as text and checks the permission rule as code. It cannot prove how PostgreSQL applies the files.

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

  it("the Prisma schema's CURRENT default is false: the later migration (below) moved it from the true that this migration added", () => {
    const schema = fs.readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");
    expect(schema).toMatch(/canEditContactDetails\s+Boolean\s+@default\(false\)/);
  });
});

describe("the default-off migration 20261122000100_account_contact_detail_edit_default_off", () => {
  const dir2 = "20261122000100_account_contact_detail_edit_default_off";
  const file2 = path.join(root, "prisma", "migrations", dir2, "migration.sql");
  const sql2 = fs.readFileSync(file2, "utf8");
  const statements2 = sql2.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

  it("is exactly one statement: SET DEFAULT false on that one column", () => {
    expect(statements2).toEqual(['ALTER TABLE "Account" ALTER COLUMN "canEditContactDetails" SET DEFAULT false']);
  });

  it("touches no existing row and nothing else: no UPDATE, DELETE, DROP, RENAME, TRUNCATE, no NOT NULL / TYPE change, no other column, no role or permission array", () => {
    const code = statements2.join(";");
    expect(code).not.toMatch(/\b(UPDATE|DELETE|DROP|RENAME|TRUNCATE|INSERT)\b/i);
    expect(code).not.toMatch(/\bSET\s+NOT\s+NULL\b|\bTYPE\b|\bADD\s+COLUMN\b/i);
    expect(code).not.toMatch(/"role"|paymentPermissions|bookingPermissions|activeSessionId|unlimitedCustomerEmailAccess/);
  });

  it("starts with no byte-order mark, is in the manifest, and is the newest migration in it (the list stays sorted)", () => {
    expect(fs.readFileSync(file2)[0]).not.toBe(0xef);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "src", "lib", "migration-manifest.json"), "utf8")) as { migrations: string[] };
    expect(manifest.migrations).toContain(dir2);
    expect([...manifest.migrations].sort()).toEqual(manifest.migrations);
    expect(fs.readdirSync(path.join(root, "prisma", "migrations")).filter((d) => d.startsWith("2026")).sort().at(-1)).toBe(manifest.migrations.at(-1));
  });

  it("every code path that creates an ADMIN stores the permission as ON explicitly (the column default no longer does it)", () => {
    const read = (p: string) => fs.readFileSync(path.join(root, ...p.split("/")), "utf8");
    expect(read("src/server/actions/accounts.ts")).toMatch(/canEditContactDetails:\s*data\.role === "ADMIN"/);
    expect(read("src/server/auth/initial-admin-bootstrap.ts")).toMatch(/role: "ADMIN",[\s\S]{0,120}canEditContactDetails: true/);
    expect(read("prisma/bootstrap-company.ts")).toMatch(/role: "ADMIN",[\s\S]{0,120}canEditContactDetails: true/);
    expect(read("prisma/seed.ts")).toMatch(/canEditContactDetails: a\.role === "ADMIN"/);
  });

  it("existing rows are never rewritten by the application either: the only UPDATE of this column is the Administrator-only permission action (a role change or any other edit does not touch it)", () => {
    const accounts = fs.readFileSync(path.join(root, "src", "server", "actions", "accounts.ts"), "utf8");
    expect(accounts.match(/data:\s*\{\s*canEditContactDetails:/g) ?? []).toHaveLength(1);
    const updateAccount = accounts.slice(accounts.indexOf("export async function updateAccount"), accounts.indexOf("export async function setAccountStatus"));
    expect(updateAccount.length).toBeGreaterThan(200);
    expect(updateAccount).not.toMatch(/canEditContactDetails/);
  });
});

describe("the permission rule the migration feeds (no accidental grant, no accidental removal)", () => {
  const ROLES = ["ADMIN", "MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const;

  it("after the FIRST migration every existing row had true, so every user kept exactly the ability they had before - nobody gained or lost access (the second migration changes only new rows)", () => {
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
