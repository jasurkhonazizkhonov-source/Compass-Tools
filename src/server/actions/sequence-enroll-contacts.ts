"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canBulkEnrollInSequence } from "@/lib/permissions";
import { contactVisibilityWhere, leadVisibilityWhere, sequenceVisibilityWhere } from "@/server/visibility";
import { enrollContacts, enrollLeads } from "@/server/actions/sequences";
import { safeErrorTag } from "@/lib/safe-error-log";
import { isRecipientMode, type RecipientMode } from "@/server/sequence-recipients";
import { checkAccountRateLimit, describeWait, RATE_LIMITS } from "@/server/security/rate-limit";

// Sequence page -> "Enroll All Contacts": enroll every contact the person may see into this sequence, without picking them one by one.
//
// It is the EXISTING enrollment, not a second one. Exactly like selecting contacts on the Contacts list: a contact that has a lead the caller can see is enrolled through
// its most recent such lead (enrollLeads, unchanged), and a contact WITHOUT one is enrolled as a contact (enrollContacts: no lead is required, created or changed). Either way
// the same checks run: authorization, company scoping, active-sequence check, a real Gmail check of the sending account, a valid and not-unsubscribed/suppressed address, and
// one ACTIVE enrollment per person and sequence under a lock. What this file adds is only the choosing of the contacts and doing it in SAFE BATCHES:
//   * the browser never receives the contacts: it asks for one batch at a time (a keyset cursor over contact ids) and gets counts back, so a database of any size is never
//     loaded into the page or into one request, and a long run can be stopped between batches;
//   * each batch is independent: a batch that fails is counted and the run carries on, and everything enrolled in earlier batches stays enrolled;
//   * running it again is harmless: contacts that already have an ACTIVE enrollment in this sequence (through ANY of their leads) are skipped, so nobody is enrolled twice.

/** Contacts examined per batch (and so leads enrolled per enrollLeads call / transaction). */
const CONTACT_BATCH_SIZE = 100; // not exported: everything exported from a "use server" module is a public Server Action

export type EnrollAllContactsPreview =
  | {
      ok: true;
      sequenceName: string;
      /** Contacts the caller can see. */
      totalContacts: number;
      /** Of those, contacts that already have an ACTIVE enrollment in this sequence (they will be skipped). */
      alreadyEnrolled: number;
    }
  | { ok: false; error: string };

export type EnrollContactsBatchResult =
  | {
      ok: true;
      sequenceName: string;
      /** Contacts examined in this batch. */
      processed: number;
      enrolled: number;
      alreadyEnrolled: number;
      missingEmail: number;
      addressSuppressed: number;
      noAssignedAgent: number;
      gmailUnavailable: number;
      inaccessible: number;
      /** Contacts whose batch failed for an unexpected reason (never counted as enrolled). */
      failedOther: number;
      gmailMessage?: string;
      /** Where the next batch starts; null when there are no more contacts. */
      nextCursor: string | null;
    }
  | { ok: false; error: string };

const NOT_AVAILABLE = "That sequence is not available. Choose an active sequence that has at least one step.";

async function authorize(sequenceId: unknown) {
  const actor = await getCurrentAccount();
  if (!actor || !canBulkEnrollInSequence(actor.role, "contacts")) return { ok: false as const, error: "You are not authorized to enroll contacts in a sequence." };
  if (typeof sequenceId !== "string" || !sequenceId.trim()) return { ok: false as const, error: NOT_AVAILABLE };
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId.trim(), isActive: true, ...sequenceVisibilityWhere(actor) },
    select: { id: true, name: true, _count: { select: { steps: true } } },
  });
  if (!sequence || sequence._count.steps === 0) return { ok: false as const, error: NOT_AVAILABLE };
  return { ok: true as const, actor, sequence };
}

export async function previewEnrollAllContacts(input: { sequenceId: string }): Promise<EnrollAllContactsPreview> {
  const auth = await authorize(input?.sequenceId);
  if (!auth.ok) return { ok: false, error: auth.error };
  const visible = contactVisibilityWhere(auth.actor);
  const [totalContacts, alreadyEnrolled] = await Promise.all([
    prisma.contact.count({ where: visible }),
    prisma.contact.count({ where: { ...visible, sequenceEnrollments: { some: { sequenceId: auth.sequence.id, status: "ACTIVE" } } } }),
  ]);
  return { ok: true, sequenceName: auth.sequence.name, totalContacts, alreadyEnrolled };
}

export async function enrollContactsBatch(input: { sequenceId: string; recipientMode?: RecipientMode; cursor?: string | null }): Promise<EnrollContactsBatchResult> {
  const auth = await authorize(input?.sequenceId);
  if (!auth.ok) return { ok: false, error: auth.error };
  const { actor, sequence } = auth;
  const limit = await checkAccountRateLimit(actor.id, "ENROLL_ALL_CONTACTS_BATCH", RATE_LIMITS.ENROLL_ALL_CONTACTS_BATCH);
  if (!limit.allowed) return { ok: false, error: `Too many batches were requested. Everyone enrolled so far stays enrolled; try again in ${describeWait(limit.retryAfterSeconds)}.` };
  // Anything but the two known values is the safe default (primary address only).
  const recipientMode: RecipientMode = isRecipientMode(input?.recipientMode) ? input.recipientMode : "primary";
  const cursor = typeof input?.cursor === "string" && input.cursor ? input.cursor : null;

  const contacts = await prisma.contact.findMany({
    where: { ...contactVisibilityWhere(actor), ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: "asc" },
    take: CONTACT_BATCH_SIZE,
    select: { id: true },
  });
  const out = {
    ok: true as const,
    sequenceName: sequence.name,
    processed: contacts.length,
    enrolled: 0,
    alreadyEnrolled: 0,
    missingEmail: 0,
    addressSuppressed: 0,
    noAssignedAgent: 0,
    gmailUnavailable: 0,
    inaccessible: 0,
    failedOther: 0,
    gmailMessage: undefined as string | undefined,
    nextCursor: contacts.length === CONTACT_BATCH_SIZE ? contacts[contacts.length - 1].id : null,
  };
  if (contacts.length === 0) return out;
  const ids = contacts.map((c) => c.id);

  try {
    // Contacts that already have an ACTIVE enrollment here - through ANY lead, or contact-only - are skipped, so nobody is enrolled twice.
    const enrolledContacts = new Set(
      (await prisma.sequenceEnrollment.findMany({ where: { sequenceId: sequence.id, status: "ACTIVE", contactId: { in: ids } }, select: { contactId: true } })).map((e) => e.contactId)
    );
    // Each remaining contact is enrolled through its most recent lead the caller can see.
    const leads = await prisma.lead.findMany({
      where: { contactId: { in: ids.filter((id) => !enrolledContacts.has(id)) }, ...leadVisibilityWhere(actor) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, contactId: true },
    });
    const leadFor = new Map<string, string>();
    for (const l of leads) if (!leadFor.has(l.contactId)) leadFor.set(l.contactId, l.id);

    out.alreadyEnrolled = ids.filter((id) => enrolledContacts.has(id)).length;
    // A contact WITHOUT a lead the caller can see is enrolled as a contact: it is never refused for lacking a lead.
    const contactOnlyIds = ids.filter((id) => !enrolledContacts.has(id) && !leadFor.has(id));
    if (contactOnlyIds.length > 0) {
      const rc = await enrollContacts(sequence.id, contactOnlyIds, { recipientMode });
      if (rc.error && Object.keys(rc.byContact).length === 0) return { ok: false, error: rc.error };
      out.enrolled += rc.enrolled;
      out.alreadyEnrolled += rc.alreadyActive;
      out.missingEmail += rc.missingEmail;
      out.addressSuppressed += rc.addressSuppressed;
      out.gmailUnavailable += rc.gmailUnavailable;
      out.inaccessible += rc.inaccessible;
      if (rc.gmailMessage) out.gmailMessage = rc.gmailMessage;
    }
    const leadIds = [...leadFor.values()];
    if (leadIds.length > 0) {
      const r = await enrollLeads(sequence.id, leadIds, undefined, { recipientMode });
      if (r.error && r.enrolled === 0 && r.gmailUnavailable === 0 && r.alreadyActive === 0 && Object.keys(r.byLead).length === 0) return { ok: false, error: r.error };
      out.enrolled += r.enrolled;
      out.alreadyEnrolled += r.alreadyActive;
      out.missingEmail += r.missingEmail;
      out.addressSuppressed += r.addressSuppressed;
      out.noAssignedAgent += r.noAssignedAgent;
      out.gmailUnavailable += r.gmailUnavailable;
      out.inaccessible += r.inaccessible;
      if (r.gmailMessage) out.gmailMessage = r.gmailMessage;
    }
    if (out.gmailMessage) return { ...out };
  } catch (err) {
    // Logged by category only (never a message, address or id). The batch is NOT counted as enrolled; the run carries on with the next one.
    console.error(`[enroll-all-contacts] a batch failed (${safeErrorTag(err)})`);
    out.failedOther = contacts.length;
    out.enrolled = 0;
    out.alreadyEnrolled = out.missingEmail = out.addressSuppressed = out.noAssignedAgent = out.gmailUnavailable = out.inaccessible = 0;
  }
  revalidatePath(`/sequences/${sequence.id}`);
  return out;
}
