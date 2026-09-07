"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { canReassignLeads, canDeleteContact } from "@/lib/permissions";
import { contactVisibilityWhere, leadVisibilityWhere } from "@/server/visibility";
import { normalizePhoneNumberWithRecovery } from "@/lib/phone";
import { performContactReassignment, recheckContactOwnershipMatch } from "@/server/contact-reassignment";
import { sendCrmEmail } from "@/server/email/crm-email";
import type { AccountRole } from "@/generated/prisma/client";

const DELETE_DENIAL = "You are not authorized to delete this contact";

/**
 * IDOR/BOLA guard shared by every action below that takes a bare contactId
 * — a restricted-role actor (Travel Agent/Flight Expert) may only act on a
 * Contact they own; Admin/Manager/Ticketing Agent act company-wide (see
 * contactVisibilityWhere). Every legitimate UI path that hands a caller a
 * contactId (the contact detail page, searchContacts's picker used by the
 * New Lead form) is already scoped this same way, so this never blocks a
 * real user flow — only a tampered/direct call referencing a contact the
 * actor was never shown.
 */
/**
 * `leadId` is an optional second grant path — a restricted-role actor
 * (Travel Agent) may not own this Contact directly (contactVisibilityWhere
 * fails), but may still legitimately be editing it FROM a specific Lead
 * page that WAS individually reassigned to them without the parent
 * Contact being reassigned too (Contact.ownerId and Lead.assignedAgentId
 * are allowed to diverge by design — see the Lead model's own doc comment).
 * Without this, every contact-mutation action below incorrectly threw
 * "Contact not found" for that exact, legitimate, non-malicious case,
 * which every caller then displayed as a generic "failed — check it's
 * valid" toast, masking the real (authorization, not validation) cause.
 */
async function assertContactAccess(
  actor: { id: string; role: AccountRole; companyId: string } | null,
  contactId: string,
  leadId?: string
) {
  if (!actor) throw new Error("Not authenticated");
  const contact = await prisma.contact.findFirst({ where: { id: contactId, ...contactVisibilityWhere(actor) }, select: { id: true } });
  if (contact) return actor;

  if (leadId) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, contactId, ...leadVisibilityWhere(actor) }, select: { id: true } });
    if (lead) return actor;
  }

  throw new Error("Contact not found");
}

/**
 * Admin/Manager only. Deletes the Contact; the database's own FK cascade
 * (Contact -> Lead -> Quote -> Booking -> PaymentMethod/PaymentCharge/
 * Passenger/etc., all declared onDelete: Cascade in schema.prisma) removes
 * every dependent record beneath it — this action does not re-implement
 * that cascade, it only gates who may trigger it and records what was
 * removed. Counts are captured BEFORE deleting since the cascaded rows are
 * gone afterward and the audit record is the only place that information
 * survives.
 */
export async function deleteContact(contactId: string) {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canDeleteContact(actor.role)) {
    await prisma.auditLog.create({
      data: { actorId: actor?.id, action: "CONTACT_DELETE_DENIED", entityType: "Contact", entityId: contactId, metadata: { reason: "MISSING_PERMISSION" } },
    });
    throw new Error(DELETE_DENIAL);
  }

  // IDOR/BOLA protection — a valid contactId alone is not enough.
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, ...contactVisibilityWhere(actor) },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      _count: { select: { leads: true, quotes: true, bookings: true } },
    },
  });
  if (!contact) {
    await prisma.auditLog.create({
      data: { actorId: actor.id, action: "CONTACT_DELETE_DENIED", entityType: "Contact", entityId: contactId, metadata: { reason: "NOT_ACCESSIBLE" } },
    });
    throw new Error(DELETE_DENIAL);
  }

  await prisma.contact.delete({ where: { id: contact.id } });

  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: "CONTACT_DELETED",
      entityType: "Contact",
      entityId: contact.id,
      metadata: {
        contactName: `${contact.firstName} ${contact.lastName}`,
        cascadedLeadCount: contact._count.leads,
        cascadedQuoteCount: contact._count.quotes,
        cascadedBookingCount: contact._count.bookings,
      },
    },
  });

  revalidatePath("/contacts");
  revalidatePath("/leads");
  revalidatePath("/quotes");
  revalidatePath("/bookings");
}

export async function updateContactField(
  contactId: string,
  patch: Partial<{ firstName: string; middleName: string | null; lastName: string }>,
  leadId?: string
) {
  const actor = await assertContactAccess(await getCurrentAccount(), contactId, leadId);
  await prisma.contact.update({ where: { id: contactId }, data: patch });
  await logActivity({
    contactId,
    actorId: actor?.id,
    type: "CONTACT_UPDATED",
    description: `Updated ${Object.keys(patch).join(", ")}`,
  });
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/contacts");
  revalidatePath("/leads");
}

/**
 * Reassigns a Contact's owner — meaning every Lead/Quote attached to it.
 * Always requires canReassignLeads: unlike a single lead, this is
 * explicitly the bulk/admin action, never a self-claim. The actual
 * transaction/notification/email work is shared with the automatic
 * system-triggered reassignment in contact-reassignment.ts (see
 * performContactReassignment) — this function's own job is purely the
 * authorization/validation gate in front of it.
 */
export async function reassignContact(contactId: string, newOwnerId: string, reason: string) {
  const actor = await getCurrentAccount();
  if (!actor || !canReassignLeads(actor.role)) {
    throw new Error("You are not authorized to reassign this contact");
  }

  const newOwner = await prisma.account.findUnique({ where: { id: newOwnerId }, select: { id: true, status: true, companyId: true } });
  if (!newOwner || newOwner.status !== "ACTIVE") {
    throw new Error("New owner must be an active CRM account");
  }
  // A contact can never be reassigned to an account in a different
  // company — that would be handing one company's customer relationship
  // to another company's staff. Verified server-side regardless of what
  // the UI's own agent picker would ever offer.
  if (newOwner.companyId !== actor.companyId) {
    throw new Error("New owner must belong to your own company");
  }

  // Same IDOR/company-isolation guard as deleteContact above — a valid
  // contactId alone is not enough.
  const contact = await prisma.contact.findUniqueOrThrow({ where: { id: contactId }, select: { companyId: true, leads: { select: { id: true } } } });
  if (contact.companyId !== actor.companyId) {
    throw new Error("Contact not found");
  }

  const result = await performContactReassignment({
    contactId,
    newOwnerId,
    reason,
    actor: { id: actor.id, fullName: actor.fullName, email: actor.email },
    auditAction: "CONTACT_REASSIGNED",
  });

  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/contacts");
  revalidatePath("/leads");
  for (const lead of contact.leads) revalidatePath(`/leads/${lead.id}`);

  return result;
}

export async function updatePrimaryPhoneNumber(contactId: string, number: string, leadId?: string) {
  const actor = await assertContactAccess(await getCurrentAccount(), contactId, leadId);
  const normalized = normalizePhoneNumberWithRecovery(number) ?? number;
  const primary = await prisma.contactPhone.findFirst({ where: { contactId, isPrimary: true } });

  if (primary) {
    await prisma.contactPhone.update({ where: { id: primary.id }, data: { number: normalized } });
  } else {
    await prisma.contactPhone.create({ data: { contactId, number: normalized, type: "MOBILE", isPrimary: true } });
  }
  await syncPrimaryPhone(contactId);

  await logActivity({
    contactId,
    actorId: actor?.id,
    type: "PHONE_UPDATED",
    description: `Primary phone updated to ${normalized}`,
  });

  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/leads");

  // Part 15/16 — the new number may now match a DIFFERENT existing
  // Contact's own phone; if so, this Contact (and its Leads/Quotes) is
  // automatically reassigned to that Contact's owner. Best-effort — never
  // turns an otherwise-successful phone edit into an error.
  await recheckContactOwnershipMatch(contactId);
}

/** Mirrors updatePrimaryPhoneNumber — the pencil-edit action for the
 * Primary Email field on the Lead/Contact detail page (Part 14). */
export async function updatePrimaryEmailAddress(contactId: string, email: string, leadId?: string) {
  const actor = await assertContactAccess(await getCurrentAccount(), contactId, leadId);
  const trimmed = email.trim().toLowerCase();
  const primary = await prisma.contactEmail.findFirst({ where: { contactId, isPrimary: true } });

  if (primary) {
    await prisma.contactEmail.update({ where: { id: primary.id }, data: { email: trimmed } });
  } else {
    await prisma.contactEmail.create({ data: { contactId, email: trimmed, type: "PERSONAL", isPrimary: true } });
  }
  await syncPrimaryEmail(contactId);

  await logActivity({
    contactId,
    actorId: actor?.id,
    type: "EMAIL_UPDATED",
    description: `Primary email updated to ${trimmed}`,
  });

  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/leads");

  // Part 15/16 — same automatic ownership recheck as the phone editor above.
  await recheckContactOwnershipMatch(contactId);
}

// Pass 25 — previously, deleting whichever phone/email happened to be
// marked primary left Contact.primaryPhone/primaryEmail null even when
// other numbers/addresses remained on file for this contact, until an
// agent noticed and manually clicked "Make primary" on a survivor. Not a
// new business rule invented here — this is the minimal, obviously-
// correct fix for a silently inconsistent state (a contact with 2 phone
// numbers on file but Contact.primaryPhone = null): if nothing is marked
// primary but at least one row still exists, promote the most recently
// added remaining one, the same way `addContactPhone`/`addContactEmail`
// already auto-promote a contact's very first number/address. Only ever
// runs when the "no primary, but rows exist" state is found — a delete
// that already leaves a real primary in place never touches anything.
async function syncPrimaryPhone(contactId: string) {
  let primary = await prisma.contactPhone.findFirst({ where: { contactId, isPrimary: true } });
  if (!primary) {
    const fallback = await prisma.contactPhone.findFirst({ where: { contactId }, orderBy: { createdAt: "desc" } });
    if (fallback) {
      primary = await prisma.contactPhone.update({ where: { id: fallback.id }, data: { isPrimary: true } });
    }
  }
  await prisma.contact.update({ where: { id: contactId }, data: { primaryPhone: primary?.number ?? null } });
}

async function syncPrimaryEmail(contactId: string) {
  let primary = await prisma.contactEmail.findFirst({ where: { contactId, isPrimary: true } });
  if (!primary) {
    const fallback = await prisma.contactEmail.findFirst({ where: { contactId }, orderBy: { createdAt: "desc" } });
    if (fallback) {
      primary = await prisma.contactEmail.update({ where: { id: fallback.id }, data: { isPrimary: true } });
    }
  }
  await prisma.contact.update({ where: { id: contactId }, data: { primaryEmail: primary?.email ?? null } });
}

const phoneSchema = z.object({
  contactId: z.string(),
  number: z.string().min(1),
  type: z.enum(["MOBILE", "HOME", "WORK", "OTHER"]).default("MOBILE"),
  isPrimary: z.boolean().default(false),
  leadId: z.string().optional(),
});

export async function addContactPhone(input: z.infer<typeof phoneSchema>) {
  const { leadId, ...parsed } = phoneSchema.parse(input);
  const data = { ...parsed, number: normalizePhoneNumberWithRecovery(parsed.number) ?? parsed.number };
  const actor = await assertContactAccess(await getCurrentAccount(), parsed.contactId, leadId);

  if (data.isPrimary) {
    await prisma.contactPhone.updateMany({ where: { contactId: data.contactId }, data: { isPrimary: false } });
  }
  const existingCount = await prisma.contactPhone.count({ where: { contactId: data.contactId } });
  const phone = await prisma.contactPhone.create({
    data: { ...data, isPrimary: data.isPrimary || existingCount === 0 },
  });
  await syncPrimaryPhone(data.contactId);

  await logActivity({
    contactId: data.contactId,
    actorId: actor?.id,
    type: "PHONE_ADDED",
    description: `Phone number added: ${data.number}`,
  });

  revalidatePath(`/contacts/${data.contactId}`);
  revalidatePath("/leads");
  return phone;
}

export async function setPrimaryPhone(contactId: string, phoneId: string, leadId?: string) {
  await assertContactAccess(await getCurrentAccount(), contactId, leadId);
  await prisma.contactPhone.updateMany({ where: { contactId }, data: { isPrimary: false } });
  // Scoped by contactId, not just phoneId — a phoneId belonging to a
  // DIFFERENT contact must never be settable as this contact's primary.
  await prisma.contactPhone.updateMany({ where: { id: phoneId, contactId }, data: { isPrimary: true } });
  await syncPrimaryPhone(contactId);
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/leads");
}

export async function deleteContactPhone(contactId: string, phoneId: string, leadId?: string) {
  await assertContactAccess(await getCurrentAccount(), contactId, leadId);
  // Scoped by contactId — previously deleted by phoneId alone, so a
  // phoneId for a DIFFERENT (even inaccessible) contact could be deleted by
  // anyone who could merely guess/enumerate its id.
  await prisma.contactPhone.deleteMany({ where: { id: phoneId, contactId } });
  await syncPrimaryPhone(contactId);
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/leads");
}

const emailSchema = z.object({
  contactId: z.string(),
  email: z.string().trim().email(),
  type: z.enum(["PERSONAL", "WORK", "OTHER"]).default("PERSONAL"),
  isPrimary: z.boolean().default(false),
  leadId: z.string().optional(),
});

export async function addContactEmail(input: z.infer<typeof emailSchema>) {
  const { leadId, ...data } = emailSchema.parse(input);
  const actor = await assertContactAccess(await getCurrentAccount(), data.contactId, leadId);

  if (data.isPrimary) {
    await prisma.contactEmail.updateMany({ where: { contactId: data.contactId }, data: { isPrimary: false } });
  }
  const existingCount = await prisma.contactEmail.count({ where: { contactId: data.contactId } });
  const email = await prisma.contactEmail.create({
    data: { ...data, isPrimary: data.isPrimary || existingCount === 0 },
  });
  await syncPrimaryEmail(data.contactId);

  await logActivity({
    contactId: data.contactId,
    actorId: actor?.id,
    type: "EMAIL_ADDED",
    description: `Email added: ${data.email}`,
  });

  revalidatePath(`/contacts/${data.contactId}`);
  revalidatePath("/leads");
  return email;
}

export async function setPrimaryEmail(contactId: string, emailId: string, leadId?: string) {
  await assertContactAccess(await getCurrentAccount(), contactId, leadId);
  await prisma.contactEmail.updateMany({ where: { contactId }, data: { isPrimary: false } });
  // Scoped by contactId, not just emailId — same reasoning as setPrimaryPhone.
  await prisma.contactEmail.updateMany({ where: { id: emailId, contactId }, data: { isPrimary: true } });
  await syncPrimaryEmail(contactId);
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/leads");
}

export async function deleteContactEmail(contactId: string, emailId: string, leadId?: string) {
  await assertContactAccess(await getCurrentAccount(), contactId, leadId);
  // Scoped by contactId — same reasoning as deleteContactPhone.
  await prisma.contactEmail.deleteMany({ where: { id: emailId, contactId } });
  await syncPrimaryEmail(contactId);
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/leads");
}

// Pass 6 — the Contact detail page's own Email button/composer. Mirrors
// leads.ts's sendLeadEmail exactly (same validation shape, same shared
// sendCrmEmail core — see that module's own comment), just resolving the
// contact directly instead of through a lead. The allowedRecipients set is
// always computed HERE, server-side, from the contact's own real email
// records — never trusted from the client — so a tampered request can
// never send through this action to an address that isn't actually on
// file for this contact.
const CONTACT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const contactEmailSchema = z.object({
  to: z
    .string()
    .min(1)
    .refine((v) => v.split(",").map((a) => a.trim()).every((a) => CONTACT_EMAIL_RE.test(a)), "Invalid email address"),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
});

export async function sendContactEmail(contactId: string, input: z.infer<typeof contactEmailSchema>) {
  const actor = await getCurrentAccount();
  if (!actor) throw new Error("Not authenticated");

  const data = contactEmailSchema.parse(input);

  // IDOR/BOLA guard — same visibility scoping as every other contact action.
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, ...contactVisibilityWhere(actor) },
    select: { id: true, primaryEmail: true, emails: { select: { email: true } } },
  });
  if (!contact) throw new Error("Contact not found");

  const allowedRecipients = new Set(
    [contact.primaryEmail, ...contact.emails.map((e) => e.email)].filter((e): e is string => !!e)
  );

  await sendCrmEmail({
    actor,
    to: data.to,
    subject: data.subject,
    body: data.body,
    allowedRecipients,
    contactId,
    emailLogType: "CONTACT_EMAIL",
  });

  revalidatePath(`/contacts/${contactId}`);
  return { ok: true as const };
}
