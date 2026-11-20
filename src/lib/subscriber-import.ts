// Subscriber import: parsing, validation and in-file de-duplication for LARGE lists, pure and synchronous so the same code is used by the preview and by the
// background job, and can be tested with synthetic data (100,000+ rows) without a database.
//
// Accepted input: one subscriber per line - "email", "email,first", "email,first,last" (comma, semicolon or tab separated), optionally with a header row
// ("email,first_name,last_name"). Quotes around a field are removed. The error report holds row NUMBERS and fixed reasons only - never an address.

export const IMPORT_MAX_ROWS = 250_000;
// 4 MB, NOT more: a pasted/uploaded list reaches the server as one Server Action request body, and next.config.ts caps those at 5 MB (serverActions.bodySizeLimit). A bigger
// file would be rejected by the framework with an opaque error before our own message could be shown. 4 MB holds roughly 150,000 ordinary addresses; larger lists are imported in parts.
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
export const IMPORT_CHUNK_SIZE = 1_000;

export type ImportRow = { row: number; email: string; firstName: string | null; lastName: string | null };

export type ImportReason = "INVALID_EMAIL" | "TOO_LONG" | "DUPLICATE_IN_FILE" | "EMPTY";

export type ParsedImport = {
  /** Rows that are valid and unique within the file, in file order. */
  valid: ImportRow[];
  totalRows: number;
  invalidRows: number;
  duplicateInFile: number;
  /** Ordered "row,reason" lines (no addresses). */
  problems: Array<{ row: number; reason: ImportReason }>;
  truncated: boolean;
};

// Deliberately conservative: a single @, a dotted domain, no whitespace/control characters/angle brackets/commas; local part up to 64, whole address up to 254.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidImportEmail(email: string): boolean {
  return email.length <= 254 && email.indexOf("@") <= 64 && EMAIL_RE.test(email);
}

const HEADER_RE = /^\s*"?(e-?mail|email address)"?\s*([,;\t]|$)/i;

function splitFields(line: string): string[] {
  const sep = line.includes("\t") ? "\t" : line.includes(";") && !line.includes(",") ? ";" : ",";
  return line.split(sep).map((f) => f.trim().replace(/^"(.*)"$/, "$1").trim());
}

function cleanName(v: string | undefined): string | null {
  if (!v) return null;
   
  const cleaned = v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 100);
  return cleaned || null;
}

export function parseImportText(text: string, limit = IMPORT_MAX_ROWS): ParsedImport {
  const valid: ImportRow[] = [];
  const problems: ParsedImport["problems"] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;
  let total = 0;
  let truncated = false;
  let row = 0;
  let start = 0;
  const n = text.length;
  let firstLine = true;

  while (start <= n) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = n;
    let line = text.slice(start, end);
    start = end + 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    row++;
    if (firstLine) {
      firstLine = false;
      line = line.replace(/^﻿/, "");
      if (HEADER_RE.test(line)) continue; // header row: not a data row, not counted
    }
    if (!line.trim()) {
      if (start > n) break;
      continue; // blank lines are ignored, not errors
    }
    if (total >= limit) {
      truncated = true;
      break;
    }
    total++;
    const [rawEmail = "", first, last] = splitFields(line);
    const email = rawEmail.toLowerCase();
    if (email.length > 254) {
      invalid++;
      problems.push({ row, reason: "TOO_LONG" });
      continue;
    }
    if (!isValidImportEmail(email)) {
      invalid++;
      problems.push({ row, reason: email ? "INVALID_EMAIL" : "EMPTY" });
      continue;
    }
    if (seen.has(email)) {
      duplicates++;
      problems.push({ row, reason: "DUPLICATE_IN_FILE" });
      continue;
    }
    seen.add(email);
    valid.push({ row, email, firstName: cleanName(first), lastName: cleanName(last) });
  }

  return { valid, totalRows: total, invalidRows: invalid, duplicateInFile: duplicates, problems, truncated };
}

/** The downloadable error report: "row,reason" lines - row numbers and fixed codes only, never an address or a name. */
export function buildErrorReport(problems: ParsedImport["problems"], maxLines = 50_000): string {
  const lines = ["row,reason"];
  for (const p of problems.slice(0, maxLines)) lines.push(`${p.row},${p.reason}`);
  if (problems.length > maxLines) lines.push(`... ${problems.length - maxLines} more`);
  return lines.join("\n");
}

/** The stored job payload: one "email,first,last" line per VALID row (row numbers are not needed again). Newlines and commas in names cannot occur (cleanName strips controls; commas are removed here). */
export function serializeValidRows(rows: ImportRow[]): string {
  return rows.map((r) => `${r.email},${(r.firstName ?? "").replace(/,/g, " ")},${(r.lastName ?? "").replace(/,/g, " ")}`).join("\n");
}

export function readPayloadSlice(payload: string, fromRow: number, count: number): { rows: Array<{ email: string; firstName: string | null; lastName: string | null }>; next: number } {
  // Walk to `fromRow` without splitting the whole payload (it can be ~10 MB); the worker advances sequentially so the walk is amortised by the cursor in practice.
  let idx = 0;
  let line = 0;
  while (line < fromRow && idx !== -1) {
    idx = payload.indexOf("\n", idx);
    if (idx === -1) return { rows: [], next: fromRow };
    idx++;
    line++;
  }
  const rows: Array<{ email: string; firstName: string | null; lastName: string | null }> = [];
  let pos = idx;
  let taken = 0;
  while (taken < count && pos < payload.length) {
    let end = payload.indexOf("\n", pos);
    if (end === -1) end = payload.length;
    const [email, first, last] = payload.slice(pos, end).split(",");
    if (email) rows.push({ email, firstName: first || null, lastName: last || null });
    pos = end + 1;
    taken++;
  }
  return { rows, next: fromRow + taken };
}
