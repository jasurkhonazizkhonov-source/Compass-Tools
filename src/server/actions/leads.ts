"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { distributeNewWebsiteLead } from "@/server/actions/lead-queue";
import { addContactPhone, addContactEmail } from "@/server/actions/contacts";
import { searchContacts } from "@/server/queries/contacts";
import { canReassignLeads, canDeleteLead, canChangeBookedLeadStatus } from "@/lib/permissions";
import { leadVisibilityWhere, contactVisibilityWhere } from "@/server/visibility";
import { sendEmail } from "@/server/email/service";
import { buildReassignmentEmail } from "@/server/email/templates";
import { getCompanyForAccountId } from "@/server/queries/company";
import { sendCrmEmail } from "@/server/email/crm-email";
import { normalizePhoneNumberWithRecovery, phoneCountryMismatch, isSupportedCountry, type CountryCode } from "@/lib/phone";
import { resolveBaseUrl } from "@/lib/company-config";
import { duplicateContactWhere } from "@/lib/contact-matching";
import { resolveContactForNewLead } from "@/server/contact-resolution";
import { Prisma, type LeadStatus } from "@/generated/prisma/client";

const createLeadSchema = z
  .object({
    contactId: z.string().optional(),
    firstName: z.string().min(1),
    middleName: z.string().optional(),
    lastName: z.string().min(1),
    phone: z.string().min(1),
    // The country the agent had selected in PhoneInput at submit time —
    // optional (older/other callers of this same schema, e.g. tests, may
    // not send it) but when present, cross-checked below against `phone`'s
    // own embedded calling code. The client already normalizes `phone` to
    // E.164 before sending (see new-lead-dialog.tsx), so this is a
    // server-side re-verification of the same check the UI already
    // performs — never trusting that a direct API caller went through it.
    phoneCountry: z.string().optional(),
    // Required for a manually-created lead — the customer must be
    // reachable by email as well as phone.
    email: z.string().trim().min(1, "Email address is required").email(),

    // From/To/Departure Date are all required; Return Date is required only
    // when tripType is ROUND_TRIP (enforced below via .superRefine, since
    // it's a cross-field rule zod's per-field validators can't express).
    departureAirportId: z.number({ error: "Departure airport is required" }),
    arrivalAirportId: z.number({ error: "Arrival airport is required" }),
    departureDate: z.string().min(1, "Departure date is required"),
    returnDate: z.string().optional(),
    tripType: z.enum(["ONE_WAY", "ROUND_TRIP", "MULTI_CITY"]),
    cabinClass: z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]),
    adults: z.number().min(1),
    children: z.number().min(0),
    infants: z.number().min(0),
    flexibleDates: z.boolean().optional(),
    preferredAirline: z.string().optional(),
    budget: z.number().optional(),
    notes: z.string().optional(),

    source: z.enum(["WEBSITE", "PHONE", "EMAIL", "WHATSAPP", "FACEBOOK", "INSTAGRAM", "REFERRAL", "OTHER"]),
    // Which existing Contact referred this lead in — only meaningful (and only
    // shown in the UI) when source === "REFERRAL". Optional even then; an
    // agent may know a lead came via referral without knowing which contact.
    referredByContactId: z.string().optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH"]),
    assignedAgentId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.tripType === "ROUND_TRIP" && !data.returnDate) {
      ctx.addIssue({ code: "custom", path: ["returnDate"], message: "Return date is required for a round trip" });
    }
    // Part 10 — manual lead creation is agent-entered, low-volume, and
    // immediately correctable, so (unlike the public website-capture path
    // below, which must never lose a real inquiry over a formatting quirk)
    // it hard-rejects a phone number that can't be confirmed at all —
    // mirroring Bulk Contacts' own established error-messaging convention
    // exactly, not inventing a new one. The Excel-mangled-NANP recovery
    // (normalizePhoneNumberWithRecovery) is attempted first so a number
    // like "1 415 325 8565" (no leading "+") is still accepted when it's
    // unambiguously a US/Canada number, without blindly prepending "+" to
    // every number regardless of shape.
    if (!normalizePhoneNumberWithRecovery(data.phone)) {
      ctx.addIssue({
        code: "custom",
        path: ["phone"],
        message: data.phone.trim().startsWith("+")
          ? `"${data.phone}" doesn't look like a valid phone number — please review it`
          : `Can't confirm the country for "${data.phone}" — include a "+" and country code (e.g. +1 for US)`,
      });
    } else if (data.phoneCountry && isSupportedCountry(data.phoneCountry) && phoneCountryMismatch(data.phone, data.phoneCountry as CountryCode)) {
      ctx.addIssue({
        code: "custom",
        path: ["phone"],
        message: "The phone number country code does not match the selected country",
      });
    }
  });

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

// Thin server-action wrapper for the "Referred By" search field in
// NewLeadDialog — resolves the viewer server-side (never trust a
// client-supplied viewer) and delegates to the visibility-scoped query.
export async function searchContactsForReferralAction(query: string, excludeContactId?: string) {
  const actor = await getCurrentAccount();
  const viewer = actor ? { id: actor.id, role: actor.role, companyId: actor.companyId } : null;
  return searchContacts(query, viewer, excludeContactId);
}

// Matches on BOTH the normalized (E.164) form of the incoming phone AND
// the raw string as originally submitted — normalized because that's the
// form all NEW writes are stored in going forward (see @/lib/phone), raw
// as a fallback so this still catches an exact-format match against older
// data that predates normalization. normalizePhoneNumber returns null for
// something that doesn't parse as a real number (e.g. a partial/invalid
// value already caught by client-side validation) — in that case only the
// raw-string condition is used, same as before this normalization existed.
// Company-scoped — matching a Contact belonging to a DIFFERENT company by
// phone/email would both leak that company's customer record into this
// one's "possible duplicate" flow and (via resolveContactForNewLead below)
// let a lead get silently attached to another company's Contact entirely.
export async function findDuplicateContact(phone: string, email: string | undefined) {
  const orConditions = duplicateContactWhere(phone, email);
  if (orConditions.length === 0) return null;
  const actor = await getCurrentAccount();
  if (!actor) return null;

  return prisma.contact.findFirst({
    where: { companyId: actor.companyId, OR: orConditions },
    include: {
      leads: { include: { departureAirport: true, arrivalAirport: true } },
      // Pass 7 — the New Lead dialog needs the owner's identity (not just
      // that a match exists) to show an accurate, specific warning about
      // what will actually happen to this new lead's ownership (see
      // createLead's own "ownerIsDifferentAgent" comment for the exact
      // rule this message must describe truthfully).
      owner: { select: { id: true, fullName: true } },
    },
  });
}

export async function createLead(input: CreateLeadInput) {
  const parsed = createLeadSchema.parse(input);
  const actor = await getCurrentAccount();
  // A Contact can never be created without a company to anchor it to (see
  // Contact.companyId's doc comment in schema.prisma) — every real
  // invocation of this action comes from an authenticated CRM session
  // (proxy.ts gates every CRM route), so a missing actor here means the
  // session lapsed mid-request, not a legitimate anonymous submission.
  if (!actor) throw new Error("Not authenticated");

  let contactId = parsed.contactId;
  let isNewContact = false;

  // A pre-selected contactId ("New Lead for Customer" from a Contact's own
  // page) is still client-supplied — confirm it actually belongs to the
  // actor's own company before reusing it, same as any other cross-company
  // IDOR check in this codebase. Never trust that the UI would only ever
  // have offered a same-company contact to select from.
  if (contactId) {
    const targetContact = await prisma.contact.findUnique({ where: { id: contactId }, select: { companyId: true } });
    if (!targetContact || targetContact.companyId !== actor.companyId) {
      throw new Error("Contact not found");
    }
  }

  // A client-supplied assignedAgentId is likewise never trusted blindly —
  // must resolve to an active account in the actor's own company. The
  // agent-picker UI is already scoped this way via listLeadEligibleAgents,
  // but that's a UX nicety, not the enforcement.
  if (parsed.assignedAgentId) {
    const targetAgent = await prisma.account.findUnique({ where: { id: parsed.assignedAgentId }, select: { companyId: true, status: true } });
    if (!targetAgent || targetAgent.companyId !== actor.companyId || targetAgent.status !== "ACTIVE") {
      throw new Error("Assigned agent must be an active account in your own company");
    }
    // Handing a brand-new lead directly to someone else at creation time is
    // the same authority as reassigning an existing one — previously
    // ungated here (unlike reassignLead/reassignContact, which both already
    // required this). Assigning to yourself never needs this check.
    if (parsed.assignedAgentId !== actor.id && !canReassignLeads(actor.role)) {
      throw new Error("You are not authorized to assign this lead to another agent");
    }
  }

  if (!contactId) {
    // No contact was pre-selected (the global "New Lead" flow) — match by
    // phone/email first, falling back to creating a new Contact only when
    // neither matches. This is the dedup path §12 requires, made
    // transactional (Serializable isolation + retry) so two concurrent
    // submissions for the same brand-new phone/email can't both pass the
    // find-check and both create a duplicate Contact — the second racer's
    // transaction fails with a serialization conflict (P2034) and retries,
    // at which point it observes the winner's now-committed row instead.
    const resolved = await resolveContactForNewLead(
      parsed.phone,
      parsed.email || undefined,
      {
        firstName: parsed.firstName,
        middleName: parsed.middleName,
        lastName: parsed.lastName,
      },
      actor.companyId,
    );
    contactId = resolved.contactId;
    isNewContact = resolved.isNewContact;
    if (isNewContact) {
      await logActivity({
        contactId,
        actorId: actor?.id,
        type: "CONTACT_CREATED",
        description: "Contact created",
      });
    }
  } else {
    // A contact was pre-selected — e.g. "New Lead for Customer" from that
    // Contact's own page. The existing contact is always preserved and
    // reused (never duplicated just because this is another request from
    // the same customer). If the agent entered a phone/email not already on
    // file for this contact, add it as an ADDITIONAL number/address (this
    // app's data model already supports multiple phones/emails per
    // contact via ContactPhone/ContactEmail) — never overwrite or discard
    // the contact's existing primary value.
    const normalizedPhone = parsed.phone ? (normalizePhoneNumberWithRecovery(parsed.phone) ?? parsed.phone) : "";
    const existingPhones = await prisma.contactPhone.findMany({ where: { contactId }, select: { number: true } });
    if (normalizedPhone && !existingPhones.some((p) => p.number === normalizedPhone)) {
      await addContactPhone({ contactId, number: normalizedPhone, type: "MOBILE", isPrimary: false });
    }
    if (parsed.email) {
      const existingEmails = await prisma.contactEmail.findMany({ where: { contactId }, select: { email: true } });
      if (!existingEmails.some((e) => e.email === parsed.email)) {
        await addContactEmail({ contactId, email: parsed.email, type: "PERSONAL", isPrimary: false });
      }
    }
  }

  // A contact cannot be recorded as having referred itself — the only real
  // "circular reference" risk with a single-level, single-hop referral
  // pointer. Silently drop rather than reject, since this can only happen
  // via a stale/tampered client value, never a normal UI flow (the search
  // field excludes the pre-selected contact from its own results).
  const referredByContactId =
    parsed.source === "REFERRAL" && parsed.referredByContactId && parsed.referredByContactId !== contactId
      ? parsed.referredByContactId
      : undefined;

  // Lead ownership rule: a lead created against an existing Contact always
  // belongs to that Contact's owner, never to whichever agent happened to
  // create it — the contact "belongs" to their owner, and a second agent
  // submitting a request for the same customer doesn't transfer that
  // relationship. Applies uniformly whether the contact was matched by
  // phone/email (the global "New Lead" flow) or pre-selected ("New Lead for
  // Customer" from the contact's own page) — same rule either way. Only
  // kicks in when the contact HAS an owner and it differs from the current
  // actor; a brand-new contact has no owner yet, so this falls through to
  // the normal assignment behavior below.
  const matchedContact = isNewContact
    ? null
    : await prisma.contact.findUnique({ where: { id: contactId }, select: { ownerId: true, owner: { select: { fullName: true } } } });
  const ownerIsDifferentAgent = !!matchedContact?.ownerId && matchedContact.ownerId !== actor?.id;
  // Below the contact-owner override, a manually-created lead (this action
  // is only ever reached from the authenticated CRM's New Lead dialog —
  // the public website's own lead-capture route builds its Lead row
  // directly and never calls this function, so it's unaffected) defaults
  // to whoever is creating it, so it's never left silently unassigned and
  // then invisible to the agent who just logged it. An explicit pick in
  // the dropdown (already permission-checked above) still wins.
  const assignedAgentId = ownerIsDifferentAgent ? matchedContact!.ownerId! : parsed.assignedAgentId || actor.id;
  const initialStatus: LeadStatus = ownerIsDifferentAgent ? "ACCEPTED" : "ATTEMPTING_TO_CONTACT";

  const lead = await prisma.lead.create({
    data: {
      contactId,
      departureAirportId: parsed.departureAirportId,
      arrivalAirportId: parsed.arrivalAirportId,
      departureDate: parsed.departureDate ? new Date(parsed.departureDate) : undefined,
      returnDate: parsed.returnDate ? new Date(parsed.returnDate) : undefined,
      tripType: parsed.tripType,
      cabinClass: parsed.cabinClass,
      adults: parsed.adults,
      children: parsed.children,
      infants: parsed.infants,
      flexibleDates: parsed.flexibleDates ?? false,
      preferredAirline: parsed.preferredAirline || undefined,
      budget: parsed.budget,
      notes: parsed.notes || undefined,
      source: parsed.source,
      referredByContactId,
      priority: parsed.priority,
      assignedAgentId,
      status: initialStatus,
      statusHistory: {
        create: [{ toStatus: initialStatus, changedById: actor?.id }],
      },
    },
  });

  await logActivity({
    leadId: lead.id,
    contactId,
    actorId: actor?.id,
    type: "LEAD_CREATED",
    description: "Lead created",
    // Pass 6 (§32.D) — the description already read "Lead created" with no
    // way to tell a manually-entered lead from a website submission without
    // separately checking the Lead's own `source` field; kept here too so
    // an Activity-only view (e.g. a future cross-record audit export) has
    // it without a join.
    metadata: { source: parsed.source },
  });

  if (ownerIsDifferentAgent) {
    await logActivity({
      leadId: lead.id,
      contactId,
      actorId: actor?.id,
      type: "LEAD_AUTO_ASSIGNED",
      description: `Lead automatically assigned to ${matchedContact!.owner!.fullName} — this contact is already assigned to them`,
      metadata: { newOwnerId: matchedContact!.ownerId!, newOwnerName: matchedContact!.owner!.fullName },
    });
  }

  // A "newly-captured website lead" is identified by more than just the
  // source field: it must be WEBSITE-sourced AND arrive with no agent
  // already picked (an agent manually logging a website inquiry and
  // assigning it themselves shouldn't get overridden by the queue) AND not
  // already auto-assigned to the matched contact's rightful owner above —
  // the queue distributor must never reassign a lead away from that owner.
  // distributeNewWebsiteLead re-checks queueDistributedAt itself, so this
  // can never double-assign a lead that's already been through the queue.
  if (parsed.source === "WEBSITE" && !parsed.assignedAgentId && !ownerIsDifferentAgent) {
    await distributeNewWebsiteLead(lead.id).catch(() => undefined);
  }

  // A brand-new Contact's owner defaults to whichever agent ends up
  // assigned to this first lead — manually chosen, or (for a website lead)
  // whoever the queue distributor just assigned above. An existing/reused
  // Contact keeps whatever owner it already has; this never overwrites one.
  if (isNewContact) {
    const ownerId = parsed.assignedAgentId
      || (await prisma.lead.findUnique({ where: { id: lead.id }, select: { assignedAgentId: true } }))?.assignedAgentId
      || undefined;
    if (ownerId) {
      await prisma.contact.update({ where: { id: contactId }, data: { ownerId } });
    }
  }

  revalidatePath("/leads");
  revalidatePath("/dashboard");
  revalidatePath(`/contacts/${contactId}`);

  return {
    leadId: lead.id,
    contactId,
    autoAssignedToOwner: ownerIsDifferentAgent ? { id: matchedContact!.ownerId!, name: matchedContact!.owner!.fullName } : undefined,
  };
}

const DELETE_LEAD_DENIAL = "You are not authorized to delete this lead";

/**
 * Admin/Manager only. Deletes the Lead — cascades to its own Quotes and,
 * through those, their Bookings (schema onDelete: Cascade), but never
 * touches the parent Contact (Lead -> Contact is the other direction of
 * that FK and is never cascaded from a Lead deletion) or the contact's
 * other leads.
 */
export async function deleteLead(leadId: string) {
  const actor = await getCurrentAccount();
  if (!actor || actor.status !== "ACTIVE" || !canDeleteLead(actor.role)) {
    await logAuditDenial("LEAD_DELETE_DENIED", "Lead", leadId, actor?.id, "MISSING_PERMISSION");
    throw new Error(DELETE_LEAD_DENIAL);
  }

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...leadVisibilityWhere(actor) },
    select: {
      id: true,
      contactId: true,
      _count: { select: { quotes: true } },
    },
  });
  if (!lead) {
    await logAuditDenial("LEAD_DELETE_DENIED", "Lead", leadId, actor.id, "NOT_ACCESSIBLE");
    throw new Error(DELETE_LEAD_DENIAL);
  }

  await prisma.lead.delete({ where: { id: lead.id } });

  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: "LEAD_DELETED",
      entityType: "Lead",
      entityId: lead.id,
      metadata: { contactId: lead.contactId, cascadedQuoteCount: lead._count.quotes },
    },
  });

  revalidatePath("/leads");
  revalidatePath(`/contacts/${lead.contactId}`);
  revalidatePath("/dashboard");
}

async function logAuditDenial(action: string, entityType: string, entityId: string, actorId: string | undefined, reason: string) {
  await prisma.auditLog.create({ data: { actorId, action, entityType, entityId, metadata: { reason } } });
}

/**
 * Shared core, deliberately WITHOUT a visibility/ownership check — used by
 * the public updateLeadStatus below (which adds that check for direct
 * user-initiated calls) AND by internal system-driven transitions that have
 * already established their own authorization through a different chain
 * (e.g. sendQuote's post-send "advance lead to QUOTED", which is
 * authorized via the quote itself, not the calling agent's lead ownership —
 * see quoteVisibilityWhere/quotes.ts).
 */
export async function applyLeadStatusChange(leadId: string, toStatus: LeadStatus, actorId: string | undefined, note?: string) {
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });

  await prisma.$transaction([
    prisma.lead.update({ where: { id: leadId }, data: { status: toStatus } }),
    prisma.leadStatusHistory.create({
      data: { leadId, fromStatus: lead.status, toStatus, changedById: actorId, note },
    }),
  ]);

  await logActivity({
    leadId,
    contactId: lead.contactId,
    actorId,
    type: "STATUS_CHANGED",
    description: `Status changed from ${lead.status} to ${toStatus}`,
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/dashboard");
}

export async function updateLeadStatus(leadId: string, toStatus: LeadStatus, note?: string) {
  const actor = await getCurrentAccount();
  const visible = await prisma.lead.findFirst({ where: { id: leadId, ...leadVisibilityWhere(actor) }, select: { id: true } });
  if (!visible) throw new Error("Lead not found");

  // Item 12 — once a lead has reached BOOKED (via the completed charged-
  // quote/ticketing workflow — see submitBooking's direct write, which
  // bypasses this function entirely and is therefore unaffected by this
  // check), only Admin/Manager may change it away from that status.
  // Every other current status is unaffected — this is deliberately narrow,
  // not a blanket status-change permission change.
  if (canChangeBookedLeadStatus(actor?.role)) {
    await applyLeadStatusChange(leadId, toStatus, actor?.id, note);
    return;
  }

  // Pass 6 fix — a plain "read status, branch, then call
  // applyLeadStatusChange (which does its OWN separate read moments
  // later)" has a real TOCTOU window: a concurrent request (e.g.
  // submitBooking completing a booking on this exact lead) can move it to
  // BOOKED in between this function's read and its write, letting a
  // non-Admin/Manager's in-flight status change slip through ungated. Fixed
  // the same way resolveContactForNewLead already handles its own
  // read-then-write race (see contact-resolution.ts): the guard check and
  // the write happen inside one Serializable transaction, reading the
  // lead's CURRENT status at the moment of the write rather than trusting
  // an earlier read, retried on a P2034 serialization conflict.
  const MAX_ATTEMPTS = 3;
  let fromStatus: LeadStatus | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const current = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
          if (current.status === "BOOKED") {
            throw new Error("Only an Admin or Manager can change a Booked lead's status");
          }
          fromStatus = current.status;
          await tx.lead.update({ where: { id: leadId }, data: { status: toStatus } });
          await tx.leadStatusHistory.create({
            data: { leadId, fromStatus: current.status, toStatus, changedById: actor?.id, note },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      break;
    } catch (err) {
      const isSerializationConflict = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
      if (isSerializationConflict && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }

  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId }, select: { contactId: true } });
  await logActivity({
    leadId,
    contactId: lead.contactId,
    actorId: actor?.id,
    type: "STATUS_CHANGED",
    description: `Status changed from ${fromStatus} to ${toStatus}`,
  });

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/dashboard");
}

const updatableLeadFields = z.object({
  departureAirportId: z.number().nullable().optional(),
  arrivalAirportId: z.number().nullable().optional(),
  departureDate: z.string().nullable().optional(),
  returnDate: z.string().nullable().optional(),
  tripType: z.enum(["ONE_WAY", "ROUND_TRIP", "MULTI_CITY"]).optional(),
  cabinClass: z.enum(["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"]).optional(),
  adults: z.number().min(1).optional(),
  children: z.number().min(0).optional(),
  infants: z.number().min(0).optional(),
  preferredAirline: z.string().nullable().optional(),
  budget: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  source: z.enum(["WEBSITE", "PHONE", "EMAIL", "WHATSAPP", "FACEBOOK", "INSTAGRAM", "REFERRAL", "OTHER"]).optional(),
  assignedAgentId: z.string().nullable().optional(),
  flexibleDates: z.boolean().optional(),
});

export async function updateLeadField(leadId: string, patch: z.infer<typeof updatableLeadFields>) {
  const data = updatableLeadFields.parse(patch);
  const actor = await getCurrentAccount();
  const existing = await prisma.lead.findFirst({
    where: { id: leadId, ...leadVisibilityWhere(actor) },
    select: { id: true, assignedAgentId: true },
  });
  if (!existing) throw new Error("Lead not found");

  // Pass 34 — real bug found and fixed: assignedAgentId was accepted here
  // with none of reassignLead()'s guards (no canReassignLeads check, no
  // same-company validation, no offer-field cleanup, no Quote.agentId
  // sync). Because leadVisibilityWhere's restricted branch is deliberately
  // company-agnostic (any account whose id equals the lead's own
  // assignedAgentId passes it — safe only because assignedAgentId can
  // structurally only ever already equal one company's account), any
  // Travel Agent who merely owns a lead could call this action directly
  // (server actions are callable independent of which UI component renders
  // a button) with an arbitrary assignedAgentId — including an account in
  // a different company — and that lead (and its customer's PII) would
  // then appear in that other account's own Leads list. The live UI only
  // ever sends `assignedAgentId: null` through this path (unassigning) and
  // routes every actual reassignment through reassignLead() instead — so a
  // non-null value here is never legitimate and is rejected outright, and
  // clearing an existing owner still requires the identical
  // canReassignLeads gate reassignLead() enforces for "move away from an
  // existing owner" (claiming an already-unassigned lead stays
  // unrestricted, matching reassignLead's own documented rule).
  if ("assignedAgentId" in data) {
    if (data.assignedAgentId !== null) {
      throw new Error("Use reassignLead to change the assigned agent");
    }
    if (existing.assignedAgentId && !canReassignLeads(actor?.role)) {
      throw new Error("You are not authorized to reassign this lead");
    }
  }

  const normalized: Record<string, unknown> = { ...data };
  if ("departureDate" in data) normalized.departureDate = data.departureDate ? new Date(data.departureDate) : null;
  if ("returnDate" in data) normalized.returnDate = data.returnDate ? new Date(data.returnDate) : null;

  const lead = await prisma.lead.update({ where: { id: leadId }, data: normalized });

  await logActivity({
    leadId,
    contactId: lead.contactId,
    actorId: actor?.id,
    type: "LEAD_UPDATED",
    description: `Updated ${Object.keys(data).join(", ")}`,
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  // Plain, serializable result — `lead.budget` is a Prisma Decimal when set,
  // which can't cross the server-action/RSC boundary to a client caller.
  return { id: lead.id };
}

/**
 * Reassigns a single lead's owner. Claiming a currently-UNASSIGNED lead is
 * always allowed (that's normal lead-claiming, not reassignment). Moving a
 * lead AWAY from an existing owner to someone else requires
 * canReassignLeads — permission is verified here, server-side, regardless
 * of what the calling UI does or does not show.
 */
export async function reassignLead(leadId: string, newOwnerId: string, reason?: string) {
  const actor = await getCurrentAccount();
  if (!actor) throw new Error("Not authenticated");
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    include: {
      contact: { select: { firstName: true, lastName: true, companyId: true } },
      assignedAgent: { select: { id: true, fullName: true, email: true } },
      departureAirport: { select: { iata: true } },
      arrivalAirport: { select: { iata: true } },
    },
  });
  // Same IDOR/company-isolation guard as deleteLead — a valid leadId alone
  // is not enough (a Lead has no companyId of its own; its Contact does).
  if (lead.contact.companyId !== actor.companyId) {
    throw new Error("Lead not found");
  }

  const previousOwner = lead.assignedAgent;
  if (previousOwner && previousOwner.id !== newOwnerId && !canReassignLeads(actor.role)) {
    throw new Error("You are not authorized to reassign this lead");
  }

  const newOwner = await prisma.account.findUnique({ where: { id: newOwnerId }, select: { id: true, fullName: true, status: true, companyId: true } });
  if (!newOwner || newOwner.status !== "ACTIVE") {
    throw new Error("New owner must be an active CRM account");
  }
  // A lead can never be reassigned to an account in a different company —
  // same rationale as reassignContact's identical check.
  if (newOwner.companyId !== actor.companyId) {
    throw new Error("New owner must belong to your own company");
  }

  // Quotes belong to a lead in this data model (Quote.leadId, alongside
  // its own independent agentId set once at creation) — reassigning the
  // lead must carry its quotes along, atomically, or a quote would stay
  // pointed at the previous (possibly now-removed) agent even though the
  // lead it belongs to has moved. Scoped to THIS lead's own quotes only —
  // a sibling lead under the same contact is untouched.
  //
  // A manual reassignment always sets status to ACCEPTED — distinct from
  // NEW (which only ever comes from acceptLeadOffer's automatic queue
  // path) and from the schema default ATTEMPTING_TO_CONTACT. This never
  // sends the lead through the website queue, never shows the 60-second
  // offer, and never touches source — it's a plain ownership handoff, not
  // a fresh lead. Applies regardless of the lead's current status.
  //
  // Pass 31 — real bug found and fixed: this update previously set
  // assignedAgentId directly without clearing offeredToId/offeredAt/
  // offerExpiresAt. If a Manager/Admin manually reassigns a Lead at the
  // exact moment it also has an ACTIVE, unexpired queue offer outstanding
  // to some other worker, the result was a genuinely impossible/
  // inconsistent row: assignedAgentId set (manually reassigned) AND
  // offeredToId/offerExpiresAt still set (the stale queue offer). Neither
  // getMyLeadOffer nor acceptLeadOffer would ever act on that stale offer
  // again (both require assignedAgentId: null), so no double-assignment
  // was ever possible — but offerLeadToNextWorker's own "is this worker
  // already mid-countdown on a DIFFERENT lead" busy-check
  // (`offeredToId = worker AND offerExpiresAt > now`) would still see the
  // stale row and could skip that worker for a genuinely new, unrelated
  // lead offer for up to the remaining offer window (up to 60s) — a real,
  // if narrow and self-healing, queue-fairness bug. Clearing the offer
  // fields here, exactly like acceptLeadOffer already does on its own
  // successful claim, closes it at the source.
  await prisma.$transaction([
    prisma.lead.update({
      where: { id: leadId },
      data: { assignedAgentId: newOwnerId, status: "ACCEPTED", offeredToId: null, offeredAt: null, offerExpiresAt: null },
    }),
    prisma.quote.updateMany({ where: { leadId }, data: { agentId: newOwnerId } }),
    prisma.leadStatusHistory.create({
      data: { leadId, fromStatus: lead.status, toStatus: "ACCEPTED", changedById: actor.id },
    }),
  ]);

  const leadLabel = `${lead.contact.firstName} ${lead.contact.lastName}${lead.departureAirport && lead.arrivalAirport ? ` — ${lead.departureAirport.iata} to ${lead.arrivalAirport.iata}` : ""}`;

  await logActivity({
    leadId,
    contactId: lead.contactId,
    actorId: actor?.id,
    type: "LEAD_REASSIGNED",
    description: previousOwner
      ? `Reassigned from ${previousOwner.fullName} to ${newOwner.fullName}${reason ? ` — ${reason}` : ""}`
      : `Assigned to ${newOwner.fullName}`,
    // Pass 6 (§32.D) — mirrors the AuditLog row below (already computing
    // this exact shape); kept on the Activity record too so the Contact/
    // Lead's own timeline has it without a join into the separate,
    // admin-only AuditLog.
    metadata: {
      previousOwnerId: previousOwner?.id ?? null,
      previousOwnerName: previousOwner?.fullName ?? null,
      newOwnerId: newOwner.id,
      newOwnerName: newOwner.fullName,
      reason: reason ?? null,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: actor?.id,
      action: "LEAD_REASSIGNED",
      entityType: "Lead",
      entityId: leadId,
      metadata: {
        previousOwnerId: previousOwner?.id ?? null,
        previousOwnerName: previousOwner?.fullName ?? null,
        newOwnerId: newOwner.id,
        newOwnerName: newOwner.fullName,
        reason: reason ?? null,
      },
    },
  });

  if (previousOwner && previousOwner.id !== newOwner.id) {
    const leadUrl = `${resolveBaseUrl()}/leads/${leadId}`;
    await prisma.notification.create({
      data: {
        accountId: previousOwner.id,
        leadId,
        type: "LEAD_REASSIGNED",
        title: `Lead reassigned: ${lead.contact.firstName} ${lead.contact.lastName}`,
        body: `Reassigned to ${newOwner.fullName} by ${actor?.fullName ?? "an admin"}.`,
      },
    });

    if (previousOwner.email && actor) {
      const company = await getCompanyForAccountId(actor.id);
      const { subject, html } = buildReassignmentEmail({
        recipientFullName: previousOwner.fullName,
        contactFullName: `${lead.contact.firstName} ${lead.contact.lastName}`,
        previousOwnerName: previousOwner.fullName,
        newOwnerName: newOwner.fullName,
        reassignedByName: actor.fullName,
        reason: reason ?? null,
        reassignedAt: new Date(),
        scope: "LEAD",
        leads: [{ label: leadLabel, url: leadUrl }],
        company,
      });
      // Sent via the reassigning admin/manager's own connected Gmail — they
      // performed the action, so the notification comes from them.
      const result = await sendEmail({ accountId: actor.id, to: previousOwner.email, subject, html, senderName: actor.fullName });
      await prisma.emailLog.create({
        data: {
          type: "LEAD_REASSIGNMENT",
          subject,
          fromEmail: actor.email,
          toEmail: previousOwner.email,
          status: result.ok ? "SENT" : "FAILED",
          errorMessage: result.ok ? undefined : result.error,
          messageId: result.ok ? result.messageId : undefined,
          leadId,
          contactId: lead.contactId,
        },
      });
    }
  }

  // Symmetric, low-cost heads-up to the new owner — no email (only the
  // previous-owner notification was required), just the same bell
  // notification type already used for queue-distributed leads.
  await prisma.notification.create({
    data: {
      accountId: newOwner.id,
      leadId,
      type: "LEAD_ASSIGNED",
      title: `Lead assigned: ${lead.contact.firstName} ${lead.contact.lastName}`,
      body: previousOwner ? `Reassigned to you by ${actor?.fullName ?? "an admin"}.` : "Assigned to you.",
    },
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath(`/contacts/${lead.contactId}`);
  return { id: leadId };
}

// Bug fix (Pass 5 audit) — addNote/deleteNote/updateNote previously had no
// authorization or visibility check at all: any caller could attach a note
// to (or, worse, delete/rewrite) any lead/contact/note in any company by
// id alone, unlike every other mutation in this file (which all go through
// leadVisibilityWhere/contactVisibilityWhere). deleteNote/updateNote in
// particular took a caller-supplied `path: {contactId?, leadId?}` used
// ONLY for revalidatePath, never actually checked against the note's real
// owner — a classic IDOR: the caller could pass any noteId alongside an
// unrelated path and the mutation would still succeed. Fixed by always
// verifying access against the note's ACTUAL lead/contact, looked up from
// the database, never from a caller-supplied value.
async function assertNoteTargetAccess(actor: Awaited<ReturnType<typeof getCurrentAccount>>, target: { contactId?: string | null; leadId?: string | null }) {
  if (target.leadId) {
    const visible = await prisma.lead.findFirst({ where: { id: target.leadId, ...leadVisibilityWhere(actor) }, select: { id: true } });
    if (!visible) throw new Error("Lead not found");
  } else if (target.contactId) {
    const visible = await prisma.contact.findFirst({ where: { id: target.contactId, ...contactVisibilityWhere(actor) }, select: { id: true } });
    if (!visible) throw new Error("Contact not found");
  } else {
    throw new Error("A note must belong to a lead or a contact");
  }
}

export async function addNote(params: { contactId?: string; leadId?: string; body: string }) {
  const actor = await getCurrentAccount();
  await assertNoteTargetAccess(actor, params);

  const note = await prisma.note.create({
    data: {
      contactId: params.contactId,
      leadId: params.leadId,
      authorId: actor?.id,
      body: params.body,
    },
  });

  await logActivity({
    contactId: params.contactId,
    leadId: params.leadId,
    actorId: actor?.id,
    type: "NOTE_ADDED",
    description: "Note added",
  });

  if (params.leadId) revalidatePath(`/leads/${params.leadId}`);
  if (params.contactId) revalidatePath(`/contacts/${params.contactId}`);
  return note;
}

export async function deleteNote(noteId: string, path: { contactId?: string; leadId?: string }) {
  const actor = await getCurrentAccount();
  const note = await prisma.note.findUniqueOrThrow({ where: { id: noteId }, select: { leadId: true, contactId: true } });
  await assertNoteTargetAccess(actor, note);

  await prisma.note.delete({ where: { id: noteId } });
  if (path.leadId) revalidatePath(`/leads/${path.leadId}`);
  if (path.contactId) revalidatePath(`/contacts/${path.contactId}`);
}

export async function updateNote(noteId: string, body: string, path: { contactId?: string; leadId?: string }) {
  const actor = await getCurrentAccount();
  const note = await prisma.note.findUniqueOrThrow({ where: { id: noteId }, select: { leadId: true, contactId: true } });
  await assertNoteTargetAccess(actor, note);

  await prisma.note.update({ where: { id: noteId }, data: { body } });
  if (path.leadId) revalidatePath(`/leads/${path.leadId}`);
  if (path.contactId) revalidatePath(`/contacts/${path.contactId}`);
}

// Task create/toggle/update/delete actions live in @/server/actions/tasks —
// shared by this embedded per-lead widget and the dedicated /tasks module.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const leadEmailSchema = z.object({
  // A single email, or a comma-separated list ("both addresses" — Part 4)
  // — every individual address must itself be a valid email.
  to: z
    .string()
    .min(1)
    .refine((v) => v.split(",").map((a) => a.trim()).every((a) => EMAIL_RE.test(a)), "Invalid email address"),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
});

/**
 * Part 2 — the Leads page's Email button. Sends a one-off, agent-authored
 * email through the SENDING AGENT'S OWN connected Gmail (never a fake/local
 * sender) — reuses buildSequenceEmail's exact plain-text-body-to-HTML
 * rendering (paragraph breaks, auto-linkify, escaping, branded wrapper +
 * signature) rather than inventing a parallel template, since a Sequence
 * step is functionally the same thing (agent-authored plain text sent as a
 * branded customer email) just triggered manually instead of by
 * automation. Recorded in the lead's own Activity Timeline (logActivity)
 * and EmailLog (type: LEAD_EMAIL) — the same two places every other
 * lead-related email/action already surfaces. The actual Gmail-send/
 * EmailLog/Activity work is shared with the Contact composer (Pass 6) via
 * sendCrmEmail — see that module's own comment for the recipient-ownership
 * security fix folded into the extraction.
 */
export async function sendLeadEmail(leadId: string, input: z.infer<typeof leadEmailSchema>) {
  const actor = await getCurrentAccount();
  if (!actor) throw new Error("Not authenticated");

  const data = leadEmailSchema.parse(input);

  // IDOR/BOLA guard — same visibility scoping as every other lead action.
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...leadVisibilityWhere(actor) },
    select: {
      id: true,
      contactId: true,
      contact: { select: { primaryEmail: true, emails: { select: { email: true } } } },
    },
  });
  if (!lead) throw new Error("Lead not found");

  const allowedRecipients = new Set(
    [lead.contact.primaryEmail, ...lead.contact.emails.map((e) => e.email)].filter((e): e is string => !!e)
  );

  await sendCrmEmail({
    actor,
    to: data.to,
    subject: data.subject,
    body: data.body,
    allowedRecipients,
    leadId,
    contactId: lead.contactId,
    emailLogType: "LEAD_EMAIL",
  });

  revalidatePath(`/leads/${leadId}`);
  return { ok: true as const };
}
