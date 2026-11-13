import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Static checks on the migration files themselves (no database involved). `prisma migrate deploy` sends each file's text to PostgreSQL as is. A
// UTF-8 byte-order mark in front of the first statement is not whitespace to PostgreSQL's scanner: bytes >= 0x80 are identifier characters, so the
// mark becomes a stray identifier ahead of the first comment/statement and the file is rejected with a syntax error. Windows editors and PowerShell's
// default UTF-8 writer add one silently (migration 20261113000100 had one before it was removed), so the check lives here, where every test run sees it.
const dir = path.join(process.cwd(), "prisma", "migrations");
const files = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ name: d.name, file: path.join(dir, d.name, "migration.sql") }));

describe("prisma/migrations/*/migration.sql", () => {
  it("every migration directory contains a non-empty migration.sql", () => {
    expect(files.length).toBeGreaterThan(70);
    for (const f of files) {
      expect(fs.existsSync(f.file), `${f.name}/migration.sql is missing`).toBe(true);
      expect(fs.statSync(f.file).size, `${f.name}/migration.sql is empty`).toBeGreaterThan(0);
    }
  });

  it("no migration file starts with a UTF-8 byte-order mark (PostgreSQL would reject the first statement)", () => {
    const withBom = files.filter((f) => {
      const b = fs.readFileSync(f.file);
      return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    });
    expect(withBom.map((f) => f.name)).toEqual([]);
  });

  it("every migration file is valid UTF-8 text with no NUL bytes and no UTF-16 byte-order mark", () => {
    for (const f of files) {
      const b = fs.readFileSync(f.file);
      expect(b.includes(0), `${f.name}: contains a NUL byte (saved as UTF-16?)`).toBe(false);
      expect((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff), `${f.name}: UTF-16 byte-order mark`).toBe(false);
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(b), `${f.name}: not valid UTF-8`).not.toThrow();
    }
  });
});
