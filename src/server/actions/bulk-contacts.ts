"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canBulkImportContacts } from "@/lib/permissions";
import { logActivity } from "@/server/activity-log";
import { validateBulkContactRow, type BulkContactFieldIssue } from "@/lib/bulk-contact-validation";

/** Admin/Manager-only, same convention as accounts.ts's own assertAdmin —
 * every bulk-contact server action independently re-asserts this, never
 * relying on the sidebar link being hidden or the page itself having
 * already checked (see proxy.ts's matching route guard for the third
 * layer). Travel Agents and every other role are rejected here even if a
 * request somehow reaches this action directly. */
async function assertBulkImportAccess() {
  const current = await getCurrentAccount();
  if (!canBulkImportContacts(current?.role)) {
    throw new Error("Only Admins and Managers can bulk-import contacts");
  }
  return current;
}

const rowSchema = z.object({
  clientId: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  emails: z.array(z.string()),
  phones: z.array(z.string()),
  notes: z.string().optional(),
  assignedAgentId: z.string().optional(),
});

export type BulkContactRowInput = z.infer<typeof rowSchema>;

export type BulkContactRowResult = {
  clientId: string;
  issues: BulkContactFieldIssue[];
  /** Emails/phones that already exist on another Contact in this company —
   * informational only, never blocks creation (Part 8: "the Admin should
   * have a deliberate choice", never a silent auto-skip/overwrite). */
  possibleDuplicates: string[];
  normalizedEmails: string[];
  normalizedPhones: string[];
};

/**
 * Validates + duplicate-checks a batch of rows WITHOUT writing anything —
 * the review step (Part 7). Same validation rules bulkCreateContacts()
 * itself re-applies at commit time, so a row that passes here is
 * guaranteed to pass there too (no client/server drift, and no
 * time-of-check/time-of-use gap wider than the single follow-up commit
 * click creates for the duplicate check specifically, which is inherently
 * informational rather than a hard constraint anyway).
 */
export async function previewBulkContacts(rows: BulkContactRowInput[]) {
  await assertBulkImportAccess();
  const actor = await getCurrentAccount();
  if (!actor) throw new Error("Not signed in");
  return validateAndCheckDuplicates(rows.map((r) => rowSchema.parse(r)), actor.companyId);
}

async function validateAndCheckDuplicates(rows: BulkContactRowInput[], companyId: string): Promise<BulkContactRowResult[]> {
  // One batch query for every email/phone across the whole import, instead
  // of a per-row round trip (Part 26 — no N+1 here even for a 100+ row
  // paste).
  const allNormalizedEmails = new Set<string>();
  const allNormalizedPhones = new Set<string>();
  const perRow = rows.map((row) => {
    const { issues, normalizedEmails, normalizedPhones } = validateBulkContactRow(row, { emails: row.emails.length, phones: row.phones.length });
    normalizedEmails.forEach((e) => allNormalizedEmails.add(e));
    normalizedPhones.forEach((p) => allNormalizedPhones.add(p));
    return { row, issues, normalizedEmails, normalizedPhones };
  });

  const [emailMatches, phoneMatches] = await Promise.all([
    allNormalizedEmails.size > 0
      ? prisma.contactEmail.findMany({
          where: { email: { in: [...allNormalizedEmails] }, contact: { companyId } },
          select: { email: true },
        })
      : Promise.resolve([]),
    allNormalizedPhones.size > 0
      ? prisma.contactPhone.findMany({
          where: { number: { in: [...allNormalizedPhones] }, contact: { companyId } },
          select: { number: true },
        })
      : Promise.resolve([]),
  ]);
  const existingEmails = new Set(emailMatches.map((e) => e.email));
  const existingPhones = new Set(phoneMatches.map((p) => p.number));

  // Also treat two rows in THIS SAME paste sharing an email/phone as
  // possible duplicates of each other — pasting the same customer twice is
  // just as real a risk as one already on file. A count (not just a Set)
  // so a value that appears exactly once across the whole batch is never
  // flagged against itself.
  const batchEmailCounts = new Map<string, number>();
  const batchPhoneCounts = new Map<string, number>();
  for (const { normalizedEmails, normalizedPhones } of perRow) {
    for (const e of normalizedEmails) batchEmailCounts.set(e, (batchEmailCounts.get(e) ?? 0) + 1);
    for (const p of normalizedPhones) batchPhoneCounts.set(p, (batchPhoneCounts.get(p) ?? 0) + 1);
  }

  return perRow.map(({ row, issues, normalizedEmails, normalizedPhones }) => {
    const possibleDuplicates: string[] = [];
    for (const e of normalizedEmails) {
      if (existingEmails.has(e)) possibleDuplicates.push(`${e} already exists in Contacts`);
      else if ((batchEmailCounts.get(e) ?? 0) > 1) possibleDuplicates.push(`${e} appears more than once in this import`);
    }
    for (const p of normalizedPhones) {
      if (existingPhones.has(p)) possibleDuplicates.push(`${p} already exists in Contacts`);
      else if ((batchPhoneCounts.get(p) ?? 0) > 1) possibleDuplicates.push(`${p} appears more than once in this import`);
    }
    return { clientId: row.clientId, issues, possibleDuplicates, normalizedEmails, normalizedPhones };
  });
}

export type BulkCreateSummary = {
  created: number;
  results: BulkContactRowResult[];
};

/**
 * Creates every row in ONE transaction — either the whole batch succeeds or
 * none of it does (Part 9: never leave the Admin with half the records
 * created and an unexplained failure). Any row that fails validation
 * blocks the entire commit rather than being silently skipped, since the
 * review step (previewBulkContacts) already gave the Admin the chance to
 * fix or remove it — reaching this action with an invalid row means the
 * client-side gate was bypassed, so it's treated as a hard error, not a
 * partial-success case.
 */
export async function bulkCreateContacts(rows: BulkContactRowInput[]): Promise<BulkCreateSummary> {
  await assertBulkImportAccess();
  const actor = await getCurrentAccount();
  if (!actor) throw new Error("Not signed in");
  if (rows.length === 0) throw new Error("No contacts to create");

  const parsedRows = rows.map((r) => rowSchema.parse(r));
  const results = await validateAndCheckDuplicates(parsedRows, actor.companyId);
  const invalidRow = results.find((r) => r.issues.length > 0);
  if (invalidRow) {
    throw new Error("One or more rows still have validation errors — fix them before creating.");
  }

  // Agent assignment is validated server-side too (never trust a
  // client-supplied assignedAgentId blindly) — every assignee must be an
  // active account in the SAME company as the importing Admin.
  const assigneeIds = [...new Set(parsedRows.map((r) => r.assignedAgentId).filter((id): id is string => !!id))];
  if (assigneeIds.length > 0) {
    const validAssignees = await prisma.account.findMany({
      where: { id: { in: assigneeIds }, companyId: actor.companyId, status: "ACTIVE" },
      select: { id: true },
    });
    const validIds = new Set(validAssignees.map((a) => a.id));
    const badRow = parsedRows.find((r) => r.assignedAgentId && !validIds.has(r.assignedAgentId));
    if (badRow) throw new Error("One or more assigned agents are invalid or no longer active.");
  }

  const byClientId = new Map(results.map((r) => [r.clientId, r]));

  // Batch createMany, not N sequential nested contact.create() calls (Part
  // 13/16 — "if the existing architecture supports batch database
  // operations safely, use them"). The original nested-create form (one
  // prisma.contact.create() per row, each with nested emails/phones/notes)
  // issues 3-6+ separate round trips PER ROW inside a single transaction —
  // confirmed live at 100 rows to genuinely exceed even a 30-second
  // transaction timeout against this app's remote (Aiven-hosted) Postgres,
  // not merely a config number to bump further. Pre-generating each
  // Contact's id client-side (rather than letting the DB default assign
  // one) is what makes this possible: createMany can't return generated
  // ids, but every child table needs its parent's id to insert against, so
  // the id has to be known upfront. Still one atomic transaction (still no
  // queue/job architecture) — just 4 statements total instead of
  // hundreds.
  const contactIds = parsedRows.map(() => crypto.randomUUID());
  const contactRows = parsedRows.map((row, i) => {
    const info = byClientId.get(row.clientId)!;
    return {
      id: contactIds[i],
      firstName: row.firstName.trim(),
      lastName: row.lastName.trim(),
      companyId: actor.companyId,
      ownerId: row.assignedAgentId || null,
      primaryEmail: info.normalizedEmails[0] ?? null,
      primaryPhone: info.normalizedPhones[0] ?? null,
    };
  });
  const emailRows = parsedRows.flatMap((row, i) => {
    const info = byClientId.get(row.clientId)!;
    return info.normalizedEmails.map((email, j) => ({ contactId: contactIds[i], email, type: "PERSONAL" as const, isPrimary: j === 0 }));
  });
  const phoneRows = parsedRows.flatMap((row, i) => {
    const info = byClientId.get(row.clientId)!;
    return info.normalizedPhones.map((number, j) => ({ contactId: contactIds[i], number, type: "MOBILE" as const, isPrimary: j === 0 }));
  });
  const noteRows = parsedRows.flatMap((row, i) => {
    const trimmed = row.notes?.trim();
    return trimmed ? [{ contactId: contactIds[i], body: trimmed, authorId: actor.id }] : [];
  });

  try {
    await prisma.$transaction([
      prisma.contact.createMany({ data: contactRows }),
      ...(emailRows.length > 0 ? [prisma.contactEmail.createMany({ data: emailRows })] : []),
      ...(phoneRows.length > 0 ? [prisma.contactPhone.createMany({ data: phoneRows })] : []),
      ...(noteRows.length > 0 ? [prisma.note.createMany({ data: noteRows })] : []),
    ]);
  } catch (err) {
    // Never let Prisma's own internal error text (transaction internals,
    // engine details) reach the Admin directly — same "no sensitive
    // internals in a validation/error message" principle as every other
    // user-facing error in this action, just also covering unexpected
    // failures this defensively, not only the ones explicitly checked for
    // above. The transaction has already rolled back atomically either
    // way (Prisma's own guarantee for a batch $transaction) — nothing was
    // partially created.
    console.error("bulkCreateContacts: transaction failed", err);
    throw new Error("Could not create the contacts — nothing was saved. Please try again, or contact support if this keeps happening.");
  }

  await logActivity({
    actorId: actor.id,
    type: "BULK_CONTACTS_IMPORTED",
    description: `Bulk-imported ${parsedRows.length} contact${parsedRows.length === 1 ? "" : "s"}`,
  });

  revalidatePath("/contacts");

  return { created: parsedRows.length, results };
}
