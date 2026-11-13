"use server";

// Bulk actions for the checkbox selection on the Leads and Contacts lists:
//   * bulkEnrollInSequence - NOT Admin-only. Allowed for exactly the roles that may already enroll a lead in a sequence
//     (canManageSequences) and that have the list (canViewLeads / canViewContacts); every record and the sequence are still
//     checked against the caller's own visibility. It reuses enrollLeads() (sequences.ts) for the actual enrollment, so duplicate
//     rules, scheduling and activity entries are the existing ones - this module only classifies each selected record first so the
//     result can say precisely what happened to each.
//   * bulkDeleteRecords - Admin-only (canBulkDeleteLeadsAndContacts). It calls the existing deleteLead() / deleteContact() for each
//     record, so row-level scope, cascade, stored-file removal and the per-record audit entry are the existing ones, and adds one
//     summary audit entry for the batch.
// Neither throws for an expected problem: errors are RETURNED (production masks the text of a thrown server-action error).
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canBulkDeleteLeadsAndContacts, canBulkEnrollInSequence } from "@/lib/permissions";
import { BULK_SELECTION_MAX, type BulkFailure } from "@/lib/bulk-selection";
import { contactVisibilityWhere, leadVisibilityWhere, sequenceVisibilityWhere } from "@/server/visibility";
import { enrollLeads } from "@/server/actions/sequences";
import { deleteContact } from "@/server/actions/contacts";
import { deleteLead } from "@/server/actions/leads";

const NOT_AVAILABLE = "No longer available to you (deleted, moved to another owner or outside your access)";
const SELECTION_ERROR = `Select between 1 and ${BULK_SELECTION_MAX} records.`;

const kindSchema = z.enum(["leads", "contacts"]);
const idsSchema = z.array(z.string().trim().min(1).max(64));

function parseSelection(kind: unknown, ids: unknown): { kind: "leads" | "contacts"; ids: string[] } | null {
  const k = kindSchema.safeParse(kind);
  const i = idsSchema.safeParse(ids);
  if (!k.success || !i.success) return null;
  const unique = [...new Set(i.data)];
  if (unique.length < 1 || unique.length > BULK_SELECTION_MAX) return null;
  return { kind: k.data, ids: unique };
}

export type BulkEnrollResult =
  | {
      ok: true;
      sequenceName: string;
      requested: number;
      enrolled: number;
      alreadyEnrolled: number;
      failed: BulkFailure[];
      /** Selected ids that are now enrolled (new or already) - the UI deselects these and keeps the rest selected. */
      settledIds: string[];
      /** Enrolled records whose contact has no email address: the sequence will mark them failed when it runs (existing behaviour). */
      withoutEmail: number;
    }
  | { ok: false; error: string };

export async function bulkEnrollInSequence(input: { sequenceId: string; kind: "leads" | "contacts"; ids: string[] }): Promise<BulkEnrollResult> {
  const selection = parseSelection(input?.kind, input?.ids);
  if (!selection) return { ok: false, error: SELECTION_ERROR };
  const sequenceId = typeof input?.sequenceId === "string" ? input.sequenceId.trim() : "";
  if (!sequenceId) return { ok: false, error: "Choose a sequence." };

  const actor = await getCurrentAccount();
  if (!actor || !canBulkEnrollInSequence(actor.role, selection.kind)) return { ok: false, error: "You are not authorized to enroll these records in a sequence." };

  // The sequence must be one THIS user may use (same scoping as the picker and enrollLeads), active, and have a first step.
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, isActive: true, ...sequenceVisibilityWhere(actor) },
    select: { id: true, name: true, _count: { select: { steps: true } } },
  });
  if (!sequence || sequence._count.steps === 0) return { ok: false, error: "That sequence is not available. Choose an active sequence that has at least one step." };

  const failed: BulkFailure[] = [];
  // selected id -> the lead that carries the enrollment (a lead selects itself; a contact is enrolled through its most recent visible lead)
  const leadForSelected = new Map<string, string>();
  const labelOf = new Map<string, string>();
  const noEmailLeadIds = new Set<string>();

  if (selection.kind === "leads") {
    const leads = await prisma.lead.findMany({
      where: { id: { in: selection.ids }, ...leadVisibilityWhere(actor) },
      select: { id: true, contact: { select: { firstName: true, lastName: true, primaryEmail: true } } },
    });
    for (const l of leads) {
      leadForSelected.set(l.id, l.id);
      labelOf.set(l.id, `${l.contact.firstName} ${l.contact.lastName}`);
      if (!l.contact.primaryEmail) noEmailLeadIds.add(l.id);
    }
    for (const id of selection.ids) if (!leadForSelected.has(id)) failed.push({ id, label: null, reason: NOT_AVAILABLE });
  } else {
    const contacts = await prisma.contact.findMany({
      where: { id: { in: selection.ids }, ...contactVisibilityWhere(actor) },
      select: { id: true, firstName: true, lastName: true, primaryEmail: true },
    });
    const visible = new Map(contacts.map((c) => [c.id, c]));
    const leads = visible.size
      ? await prisma.lead.findMany({
          where: { contactId: { in: [...visible.keys()] }, ...leadVisibilityWhere(actor) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, contactId: true },
        })
      : [];
    for (const l of leads) if (!leadForSelected.has(l.contactId)) leadForSelected.set(l.contactId, l.id); // first row per contact = most recent
    for (const id of selection.ids) {
      const c = visible.get(id);
      if (!c) {
        failed.push({ id, label: null, reason: NOT_AVAILABLE });
        continue;
      }
      labelOf.set(id, `${c.firstName} ${c.lastName}`);
      if (!leadForSelected.has(id)) failed.push({ id, label: labelOf.get(id)!, reason: "Has no lead you can access - sequences are enrolled through a lead" });
      else if (!c.primaryEmail) noEmailLeadIds.add(leadForSelected.get(id)!);
    }
  }

  const eligible = [...leadForSelected.entries()]; // [selectedId, leadId]
  const existing = eligible.length
    ? await prisma.sequenceEnrollment.findMany({ where: { sequenceId, leadId: { in: eligible.map(([, leadId]) => leadId) }, status: "ACTIVE" }, select: { leadId: true } })
    : [];
  const alreadyLeadIds = new Set(existing.map((e) => e.leadId));
  const alreadyEnrolledIds = eligible.filter(([, leadId]) => alreadyLeadIds.has(leadId)).map(([id]) => id);
  const toEnroll = eligible.filter(([, leadId]) => !alreadyLeadIds.has(leadId));

  let enrolled = 0;
  const enrolledIds: string[] = [];
  if (toEnroll.length > 0) {
    try {
      const result = await enrollLeads(sequence.id, toEnroll.map(([, leadId]) => leadId));
      if ("error" in result && result.error) return { ok: false, error: result.error };
      // enrollLeads reports what happened to EVERY lead (an enrollment created in the meantime, no email address, no assigned agent, the
      // sending agent's Gmail not connected, ...), so nothing is guessed from counts: only a lead it really enrolled is counted as enrolled,
      // only one that already had an ACTIVE enrollment as already enrolled, and every other lead is reported with its actual reason.
      for (const [selectedId, leadId] of toEnroll) {
        const outcome = result.byLead[leadId];
        if (outcome === "enrolled") enrolledIds.push(selectedId);
        else if (outcome === "alreadyActive") alreadyEnrolledIds.push(selectedId);
        else {
          const reason =
            outcome === "missingEmail"
              ? "No email address on file - add one to the contact first"
              : outcome === "noAssignedAgent"
                ? "No agent is assigned to this lead to send from"
                : outcome === "gmailUnavailable"
                  ? (result.gmailMessage ?? "Gmail is not connected for the agent who sends this lead's emails")
                  : NOT_AVAILABLE;
          failed.push({ id: selectedId, label: outcome === "inaccessible" || outcome === undefined ? null : (labelOf.get(selectedId) ?? null), reason });
        }
      }
      enrolled = enrolledIds.length;
    } catch {
      return { ok: false, error: "The sequence could not be applied, so nothing was enrolled. Please try again." };
    }
  }

  revalidatePath("/leads");
  revalidatePath("/contacts");
  return {
    ok: true,
    sequenceName: sequence.name,
    requested: selection.ids.length,
    enrolled,
    alreadyEnrolled: alreadyEnrolledIds.length,
    failed: failed.map((f) => ({ ...f, label: f.label ?? labelOf.get(f.id) ?? null })),
    settledIds: [...enrolledIds, ...alreadyEnrolledIds],
    withoutEmail: enrolledIds.filter((id) => noEmailLeadIds.has(leadForSelected.get(id)!)).length,
  };
}

export type BulkDeleteResult =
  | { ok: true; requested: number; deleted: number; deletedIds: string[]; failed: BulkFailure[] }
  | { ok: false; error: string };

export async function bulkDeleteRecords(input: { kind: "leads" | "contacts"; ids: string[] }): Promise<BulkDeleteResult> {
  const selection = parseSelection(input?.kind, input?.ids);
  if (!selection) return { ok: false, error: SELECTION_ERROR };

  const actor = await getCurrentAccount();
  if (!actor || !canBulkDeleteLeadsAndContacts(actor.role)) {
    await prisma.auditLog.create({
      data: { actorId: actor?.id, action: "BULK_DELETE_DENIED", entityType: selection.kind === "leads" ? "Lead" : "Contact", entityId: "bulk", metadata: { reason: "MISSING_PERMISSION", requested: selection.ids.length } },
    });
    return { ok: false, error: "Only an Administrator can delete several records at once." };
  }

  // Names for the result list, read before anything is deleted and limited to records this Admin can see.
  const labels = new Map<string, string>();
  if (selection.kind === "leads") {
    const rows = await prisma.lead.findMany({ where: { id: { in: selection.ids }, ...leadVisibilityWhere(actor) }, select: { id: true, contact: { select: { firstName: true, lastName: true } } } });
    for (const r of rows) labels.set(r.id, `${r.contact.firstName} ${r.contact.lastName}`);
  } else {
    const rows = await prisma.contact.findMany({ where: { id: { in: selection.ids }, ...contactVisibilityWhere(actor) }, select: { id: true, firstName: true, lastName: true } });
    for (const r of rows) labels.set(r.id, `${r.firstName} ${r.lastName}`);
  }

  const deletedIds: string[] = [];
  const failed: BulkFailure[] = [];
  for (const id of selection.ids) {
    if (!labels.has(id)) {
      failed.push({ id, label: null, reason: NOT_AVAILABLE });
      continue;
    }
    try {
      // The existing single-record deletion: re-checks role and scope, cascades as the database already does, removes stored
      // files, writes the per-record audit entry.
      if (selection.kind === "leads") await deleteLead(id);
      else await deleteContact(id);
      deletedIds.push(id);
    } catch {
      failed.push({ id, label: labels.get(id) ?? null, reason: "Could not be deleted - it may have already been removed, or related records prevent it" });
    }
  }

  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: selection.kind === "leads" ? "LEADS_BULK_DELETED" : "CONTACTS_BULK_DELETED",
      entityType: selection.kind === "leads" ? "Lead" : "Contact",
      entityId: "bulk",
      metadata: { requested: selection.ids.length, deleted: deletedIds.length, failed: failed.length, deletedIds },
    },
  });

  revalidatePath("/leads");
  revalidatePath("/contacts");
  revalidatePath("/dashboard");
  return { ok: true, requested: selection.ids.length, deleted: deletedIds.length, deletedIds, failed };
}
