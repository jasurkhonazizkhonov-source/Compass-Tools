// Pure, DOM-free parsing for Bulk Contacts' Excel/Google Sheets paste
// support (src/components/contacts/bulk-contact-import.tsx). Kept in its
// own plain module so the parsing logic is directly unit-testable.

export type ParsedPasteRow = {
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
  notes: string;
};

// A cell containing "@" is treated as an email; deliberately not a full
// email-format validation here (that's validateBulkContactRow's job once
// the value lands in a real row) — this only needs to distinguish "looks
// like an email" from "looks like a phone number" from "plain text",
// so an invalid-but-email-shaped paste still lands in the Email column
// (and gets a clear validation error there) rather than silently in Notes.
const EMAIL_LIKE = /@/;
// Mostly digits/phone punctuation, at least 6 characters — matches
// "+14155551234", "+44 20 7123 4567", "(415) 555-1234", "415-555-1234".
// Deliberately permissive (real parsing/validation is normalizePhoneNumber's
// job) — this only needs to avoid classifying a phone-shaped cell as a note.
const PHONE_LIKE = /^\+?[\d\s().-]{6,}$/;

export function classifyPasteCell(raw: string): "email" | "phone" | "notes" {
  const trimmed = raw.trim();
  if (EMAIL_LIKE.test(trimmed)) return "email";
  if (PHONE_LIKE.test(trimmed)) return "phone";
  return "notes";
}

/** Recognizes a copied header row (e.g. Excel's own "First Name" column
 * title) so it's skipped rather than inserted as a bogus contact row when
 * arbitrary-order header mapping (below) doesn't apply. */
function looksLikeHeaderRow(cells: string[]): boolean {
  const first = (cells[0] ?? "").trim().toLowerCase();
  const second = (cells[1] ?? "").trim().toLowerCase();
  return /^first\s*name$/.test(first) && /^last\s*name$/.test(second);
}

export type HeaderField = "firstName" | "lastName" | "email" | "phone" | "notes" | "assignedUser";

// Common real-world header variants (Part 9/13) — matched case-insensitively
// against a trimmed cell. Deliberately a fixed, hand-reviewed list rather
// than a fuzzy/similarity match: a wrong guess here silently misfiles an
// entire column, so every pattern is something a spreadsheet realistically
// contains, nothing looser.
const HEADER_PATTERNS: Record<HeaderField, RegExp[]> = {
  firstName: [/^first\s*name$/i, /^first$/i, /^firstname$/i, /^given\s*name$/i],
  lastName: [/^last\s*name$/i, /^last$/i, /^lastname$/i, /^surname$/i, /^family\s*name$/i],
  email: [/^emails?$/i, /^email\s*\d+$/i, /^email\s*address(es)?$/i, /^email\s*address\s*\d+$/i, /^e-?mail$/i],
  phone: [/^phones?$/i, /^phone\s*\d+$/i, /^phone\s*number(s)?$/i, /^phone\s*number\s*\d+$/i, /^mobile(\s*phone)?$/i, /^mobile\s*\d+$/i, /^cell(\s*phone)?$/i],
  notes: [/^notes?$/i, /^comments?$/i],
  assignedUser: [/^assigned\s*user$/i, /^assigned\s*agent$/i, /^assigned\s*to$/i, /^agent$/i, /^owner$/i],
};

function matchHeaderField(cell: string): HeaderField | null {
  const trimmed = cell.trim();
  if (!trimmed) return null;
  for (const field of Object.keys(HEADER_PATTERNS) as HeaderField[]) {
    if (HEADER_PATTERNS[field].some((pattern) => pattern.test(trimmed))) return field;
  }
  return null;
}

/**
 * Arbitrary-column-order header mapping (Part 9 / prior-limitation #1):
 * `Last Name | Email | First Name | Phone | Notes` maps correctly even
 * though the columns aren't in the table's own left-to-right order.
 * Deliberately strict — returns null (meaning "fall back to positional +
 * content-sniffing") unless EVERY non-blank header cell is confidently
 * recognized. A single unrecognized column (an Excel export with an extra
 * "Company" or "Source" column, say) is exactly the "ambiguous — do not
 * guess silently" case the spec calls out, so the whole row is left to the
 * existing, safe positional/content-sniffing path rather than guessing at
 * partial credit; the caller surfaces this to the user rather than
 * silently switching strategies (see bulk-contact-import.tsx's toast).
 */
export function detectHeaderColumnMap(headerRow: string[]): (HeaderField | null)[] | null {
  if (headerRow.length === 0) return null;
  const mapped = headerRow.map(matchHeaderField);
  if (mapped.every((f) => f === null)) return null; // not a header row at all
  if (mapped.some((f, i) => f === null && headerRow[i].trim() !== "")) return null; // an unrecognized non-blank header — bail out
  return mapped;
}

/** True if the row looks like it was MEANT as a header (at least one cell
 * recognized) even if detectHeaderColumnMap ultimately declined to use it
 * (an unrecognized column made the overall mapping unsafe) — lets the
 * caller tell the user "this looked like a header but wasn't fully
 * recognized, falling back to automatic detection" instead of silently
 * switching strategies with no explanation. */
export function hasAnyRecognizedHeaderCell(headerRow: string[]): boolean {
  return headerRow.some((cell) => matchHeaderField(cell) !== null);
}

/** Builds structured rows from a grid whose first row is a header
 * recognized by detectHeaderColumnMap — multiple columns mapped to the
 * same field (e.g. two "Email" headers) accumulate in left-to-right order,
 * same as the content-sniffing path. The Assigned User column's raw text
 * is returned as-is (assignedUserRaw) for the caller to match against the
 * CRM's real user list — this module has no knowledge of accounts. */
export function mapPasteRowsByHeader(grid: string[][], columnMap: (HeaderField | null)[]): (ParsedPasteRow & { assignedUserRaw: string })[] {
  return grid.slice(1).map((cells) => {
    let firstName = "";
    let lastName = "";
    const emails: string[] = [];
    const phones: string[] = [];
    const notesParts: string[] = [];
    let assignedUserRaw = "";
    columnMap.forEach((field, i) => {
      const value = (cells[i] ?? "").trim();
      if (!value || !field) return;
      if (field === "firstName") firstName = value;
      else if (field === "lastName") lastName = value;
      else if (field === "email") emails.push(value);
      else if (field === "phone") phones.push(value);
      else if (field === "notes") notesParts.push(value);
      else if (field === "assignedUser") assignedUserRaw = value;
    });
    return { firstName, lastName, emails, phones, notes: notesParts.join(" "), assignedUserRaw };
  });
}

/** Exact-match only (Part 10) — a pasted Assigned User cell matches an
 * existing CRM user by exact (case-insensitive) full name or exact email,
 * and ONLY if that match is unambiguous (exactly one candidate). Multiple
 * candidates (e.g. two agents happen to share a display name) or zero
 * candidates return null rather than guessing — the row is simply left
 * unassigned, same as today, for the Admin/Manager to set manually or via
 * "Assign selected rows to...". */
export function matchAssignedUser(raw: string, agents: { id: string; fullName: string; email?: string }[]): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const matches = agents.filter((a) => a.fullName.trim().toLowerCase() === trimmed || a.email?.trim().toLowerCase() === trimmed);
  return matches.length === 1 ? matches[0].id : null;
}

/** Splits pasted spreadsheet text (rows separated by newlines, columns by
 * tabs) into a 2D grid. A single cell with no tabs/newlines returns a 1x1
 * grid, so the caller can treat "plain paste into one field" and "paste a
 * whole block" the same way. */
export function parsePasteGrid(text: string): string[][] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line, i, arr) => !(i === arr.length - 1 && line === "")) // drop trailing blank line from a copied range
    .map((line) => line.split("\t"));
}

/**
 * Classifies a pasted grid into structured rows. `assumeNameColumns`
 * controls whether the first two cells of each line are treated as First/
 * Last Name (true when the paste started in the First Name column — the
 * overwhelmingly common case, matching every example in the spec) or
 * whether every cell should be content-sniffed with no name columns
 * assumed (a paste started directly in an Email/Phone/Notes cell, e.g.
 * pasting a plain list of email addresses into the Email column).
 *
 * Every email/phone-shaped cell is kept regardless of how many columns
 * currently exist in the table — Part 12's "if the pasted data contains
 * more email/phone columns than currently exist, automatically create the
 * required columns" is handled by the caller comparing
 * `emails.length`/`phones.length` across the returned rows against the
 * table's current column count and expanding it, rather than by this
 * function needing to know about the table's UI state at all.
 */
export function classifyPasteRows(grid: string[][], assumeNameColumns: boolean): ParsedPasteRow[] {
  const dataRows = grid.length > 0 && assumeNameColumns && looksLikeHeaderRow(grid[0]) ? grid.slice(1) : grid;

  return dataRows.map((cells) => {
    const firstName = assumeNameColumns ? (cells[0] ?? "").trim() : "";
    const lastName = assumeNameColumns ? (cells[1] ?? "").trim() : "";
    const rest = assumeNameColumns ? cells.slice(2) : cells;

    const emails: string[] = [];
    const phones: string[] = [];
    const notesParts: string[] = [];
    for (const raw of rest) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const kind = classifyPasteCell(trimmed);
      if (kind === "email") emails.push(trimmed);
      else if (kind === "phone") phones.push(trimmed);
      else notesParts.push(trimmed);
    }

    return { firstName, lastName, emails, phones, notes: notesParts.join(" ") };
  });
}
