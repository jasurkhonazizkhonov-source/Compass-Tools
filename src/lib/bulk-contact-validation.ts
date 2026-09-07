// Pure, DB-free validation for a single Bulk Contacts row (see
// src/server/actions/bulk-contacts.ts, which adds the batched
// duplicate-lookup DB query on top of this). Kept in its own plain module
// (not the "use server" action file, which may only export async
// functions) so this half is directly unit-testable without mocking
// Prisma — same pattern as booking-schema.ts's passengerSchema.
import { z } from "zod";
import { normalizePhoneNumberWithRecovery } from "@/lib/phone";

export type BulkContactFieldIssue = { field: "firstName" | "lastName" | "email" | "phone"; index?: number; message: string };

export type BulkContactRowLike = {
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
};

/** "Email" when this is the only email column, "Email 2" when there are
 * more — matches the table's own header labeling (bulk-contact-import.tsx)
 * so a validation message never names a column the UI itself doesn't show.
 * columnCount is optional so existing callers/tests that don't track it
 * still get a sensible default (always-numbered, never ambiguous). */
function fieldLabel(kind: "Email" | "Phone", index: number, columnCount?: number) {
  return columnCount === 1 ? kind : `${kind} ${index + 1}`;
}

export function validateBulkContactRow(
  row: BulkContactRowLike,
  columnCounts?: { emails?: number; phones?: number }
): { issues: BulkContactFieldIssue[]; normalizedEmails: string[]; normalizedPhones: string[] } {
  const issues: BulkContactFieldIssue[] = [];
  if (!row.firstName.trim()) issues.push({ field: "firstName", message: "First name is required" });
  if (!row.lastName.trim()) issues.push({ field: "lastName", message: "Last name is required" });

  const normalizedEmails: string[] = [];
  row.emails.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const normalized = trimmed.toLowerCase();
    // Zod's own built-in email validator — same as every other email field
    // in this CRM, not an overly-restrictive hand-rolled regex, so a
    // legitimate modern address is never rejected just for being unusual.
    if (!z.string().email().safeParse(normalized).success) {
      issues.push({ field: "email", index, message: `${fieldLabel("Email", index, columnCounts?.emails)} appears to be invalid — please review "${raw}"` });
      return;
    }
    normalizedEmails.push(normalized);
  });

  const normalizedPhones: string[] = [];
  row.phones.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Same normalizer every other phone field in the CRM uses. No default
    // country is assumed for a bare, non-"+"-prefixed number pasted in
    // bulk — guessing a country for an ambiguous national number risks
    // silently storing the wrong one, so it's flagged for the Admin to
    // confirm/correct instead, same as an unparseable number. The one
    // exception is the exact Excel-mangled-NANP shape (src/lib/phone.ts's
    // normalizePhoneNumberWithRecovery), which is unambiguous rather than a
    // guess.
    const normalized = normalizePhoneNumberWithRecovery(trimmed);
    if (!normalized) {
      issues.push({
        field: "phone",
        index,
        message: trimmed.startsWith("+")
          ? `${fieldLabel("Phone", index, columnCounts?.phones)} appears to be invalid — please review "${raw}"`
          : `Can't confirm the country for ${fieldLabel("Phone", index, columnCounts?.phones)} ("${raw}") — include a "+" and country code (e.g. +1 for US)`,
      });
      return;
    }
    normalizedPhones.push(normalized);
  });

  return { issues, normalizedEmails, normalizedPhones };
}
