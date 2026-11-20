import { describe, it, expect } from "vitest";
import { IMPORT_MAX_ROWS, buildErrorReport, isValidImportEmail, parseImportText, readPayloadSlice, serializeValidRows } from "../subscriber-import";

// Synthetic data only: example.test addresses generated here. Nothing is imported anywhere.

describe("isValidImportEmail", () => {
  it("accepts ordinary addresses and rejects malformed ones", () => {
    for (const ok of ["a@b.co", "first.last+tag@sub.example.com", "o'brien@example.org", "x_y@ex-ample.io"]) expect(isValidImportEmail(ok), ok).toBe(true);
    for (const bad of ["", "plain", "a@b", "a@@b.com", "a b@c.com", "a@b..com", "@b.com", "a@.com", "a@b.com.", "a,b@c.com", "a@-b.com", `${"x".repeat(65)}@b.com`, `a@${"x".repeat(250)}.com`, "<a>@b.com"]) {
      expect(isValidImportEmail(bad), bad).toBe(false);
    }
  });
});

describe("parseImportText", () => {
  it("reads email[,first[,last]], with or without a header, quotes, tabs, semicolons, CRLF and a BOM", () => {
    const text = "﻿Email,First Name,Last Name\r\nAda@Example.com,Ada,Lovelace\r\n\"grace@example.com\";Grace;Hopper\r\nalan@example.com\tAlan\tTuring\r\nplain@example.com\r\n";
    const r = parseImportText(text);
    expect(r.totalRows).toBe(4); // the header row is not a data row
    expect(r.valid.map((v) => v.email)).toEqual(["ada@example.com", "grace@example.com", "alan@example.com", "plain@example.com"]);
    expect(r.valid[0]).toMatchObject({ firstName: "Ada", lastName: "Lovelace" });
    expect(r.valid[3]).toMatchObject({ firstName: null, lastName: null });
  });

  it("counts invalid and duplicate rows separately, keeps the first of a duplicate, and ignores blank lines", () => {
    const r = parseImportText("a@example.com\n\nnot-an-email\nA@EXAMPLE.COM\nb@example.com\n,only-name\n");
    expect(r.totalRows).toBe(5);
    expect(r.valid.map((v) => v.email)).toEqual(["a@example.com", "b@example.com"]);
    expect(r.invalidRows).toBe(2);
    expect(r.duplicateInFile).toBe(1);
    expect(r.problems.map((p) => p.reason)).toEqual(["INVALID_EMAIL", "DUPLICATE_IN_FILE", "EMPTY"]);
  });

  it("strips control characters and markup from names and caps their length", () => {
    const r = parseImportText(`a@example.com,"Eve\u0000<script>",${"L".repeat(500)}`);
    expect(r.valid[0].firstName).toBe("Evescript");
    expect(r.valid[0].lastName!.length).toBe(100);
  });

  it("stops at the row limit and says so", () => {
    const r = parseImportText("a@example.com\nb@example.com\nc@example.com", 2);
    expect(r.truncated).toBe(true);
    expect(r.valid).toHaveLength(2);
  });

  it("the error report holds row numbers and fixed codes only - never an address or a name", () => {
    const r = parseImportText("secret.person@example.com,Secret,Person\nbroken\nsecret.person@example.com\n");
    const report = buildErrorReport(r.problems);
    expect(report).toBe("row,reason\n2,INVALID_EMAIL\n3,DUPLICATE_IN_FILE");
    expect(report).not.toMatch(/secret|@|Person/i);
  });

  it("handles 100,000 rows (with realistic noise) quickly and correctly", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      if (i % 50 === 0) lines.push(`bad-row-${i}`); // 2,000 invalid
      else if (i % 20 === 0) lines.push(`user${i - 20}@example.test,Dup,Row`); // duplicates of earlier users
      else lines.push(`user${i}@example.test,First${i},Last${i}`);
    }
    const t0 = Date.now();
    const r = parseImportText(lines.join("\n"));
    const ms = Date.now() - t0;
    expect(r.totalRows).toBe(100_000);
    expect(r.invalidRows).toBe(2_000);
    expect(r.valid.length + r.invalidRows + r.duplicateInFile).toBe(100_000);
    expect(new Set(r.valid.map((v) => v.email)).size).toBe(r.valid.length); // unique
    expect(ms).toBeLessThan(5_000);
  });

  it("the default ceiling is 250,000 rows", () => {
    expect(IMPORT_MAX_ROWS).toBe(250_000);
  });
});

describe("payload round trip (what the background job stores and reads back)", () => {
  it("serialises valid rows and reads them back in cursor-sized slices, without losing or repeating a row", () => {
    const rows = Array.from({ length: 2_503 }, (_, i) => ({ row: i + 1, email: `u${i}@example.test`, firstName: i % 3 ? `F${i}` : null, lastName: i % 5 ? `L, ${i}` : null }));
    const payload = serializeValidRows(rows);
    const seen: string[] = [];
    let cursor = 0;
    while (true) {
      const { rows: slice, next } = readPayloadSlice(payload, cursor, 1_000);
      if (slice.length === 0) break;
      seen.push(...slice.map((s) => s.email));
      cursor = next;
    }
    expect(seen).toEqual(rows.map((r) => r.email));
    expect(cursor).toBe(2_503);
    // a restart at an arbitrary cursor continues exactly there
    expect(readPayloadSlice(payload, 1_500, 3).rows.map((r) => r.email)).toEqual(["u1500@example.test", "u1501@example.test", "u1502@example.test"]);
    // a comma inside a name cannot shift columns
    expect(readPayloadSlice(payload, 1, 1).rows[0]).toMatchObject({ email: "u1@example.test", firstName: "F1", lastName: "L  1" });
  });

  it("reading past the end returns nothing", () => {
    expect(readPayloadSlice("a@x.co,,\nb@x.co,,", 5, 10)).toEqual({ rows: [], next: 5 });
  });
});
