"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { classifyLeadsForEnrollment, describeGmailProblem, gmailProblemNeedsReconnect, type GmailProblemCode } from "@/server/sequence-enrollment-eligibility";
import { checkGmailSendReadiness } from "@/server/email/gmail-send";
import { RESOLVED_PREFIX, RETRY_EPOCH_PREFIX, isRecentInFlight, markerReason, openDelivery } from "@/lib/sequence-delivery";
import { assertTransition } from "@/lib/sequence-delivery-state";
import { logActivity } from "@/server/activity-log";
import { canManageSequences, canManageAllSequences } from "@/lib/permissions";
import { runDueSequenceSteps } from "@/server/due-sequence-steps";
import { contactVisibilityWhere, leadVisibilityWhere, sequenceVisibilityWhere } from "@/server/visibility";
import { classifyContactsForEnrollment, type ContactVerdict } from "@/server/sequence-contact-eligibility";
import { activitySubject, enrollmentSender } from "@/server/sequence-sender";
import { getEmailViewer, resolveSendRecipients } from "@/server/privacy/customer-email";
import { isRecipientMode, type RecipientMode } from "@/server/sequence-recipients";
import { checkAccountRateLimit, describeWait, RATE_LIMITS } from "@/server/security/rate-limit";
import { analyzeStepContent, sanitizeStepHtml } from "@/server/email/sequence-content";

const SEQUENCE_NOT_FOUND = "Sequence not found";

/** IDOR/BOLA + ownership guard shared by every sequence mutation below — a
 * restricted-role actor may only act on a sequence THEY created;
 * Admin/Manager act on any sequence company-wide (Part 12). Distinct from
 * canManageSequences(role) alone, which only answers "can this role manage
 * sequences at all" — this additionally confirms THIS specific sequence. */
async function assertSequenceAccess(actor: Awaited<ReturnType<typeof getCurrentAccount>>, sequenceId: string) {
  if (!actor || !canManageSequences(actor.role)) throw new Error(SEQUENCE_NOT_FOUND);
  const sequence = await prisma.sequence.findFirst({ where: { id: sequenceId, ...sequenceVisibilityWhere(actor) } });
  if (!sequence) throw new Error(SEQUENCE_NOT_FOUND);
  return sequence;
}

/**
 * Access to the LEAD an enrollment belongs to, in addition to access to its sequence. A sequence a person may use does not make every lead in it theirs: a lead
 * can be reassigned, or belong to someone else's team, after it was enrolled. Recovery and unenroll actions send mail from, or stop mail for, that lead, so the
 * caller must be able to see the lead under the ordinary row-level rule (company, assigned agent, manager team). The answer is the same generic "not found"
 * as a missing enrollment, so nothing is revealed about leads the caller may not see.
 */
async function assertLeadAccess(actor: NonNullable<Awaited<ReturnType<typeof getCurrentAccount>>>, leadId: string) {
  const visible = await prisma.lead.findFirst({ where: { id: leadId, ...leadVisibilityWhere(actor) }, select: { id: true } });
  if (!visible) throw new Error(SEQUENCE_NOT_FOUND);
}

/** The contact-only counterpart of assertLeadAccess: the caller must be able to see the CONTACT under the ordinary row-level rule (company, owner, manager team). */
async function assertContactAccess(actor: NonNullable<Awaited<ReturnType<typeof getCurrentAccount>>>, contactId: string) {
  const visible = await prisma.contact.findFirst({ where: { id: contactId, ...contactVisibilityWhere(actor) }, select: { id: true } });
  if (!visible) throw new Error(SEQUENCE_NOT_FOUND);
}

/** Access to whoever an enrollment is about: its lead when it has one (unchanged), else its contact. */
async function assertEnrollmentSubjectAccess(actor: NonNullable<Awaited<ReturnType<typeof getCurrentAccount>>>, enrollment: { leadId: string | null; contactId: string }) {
  if (enrollment.leadId) await assertLeadAccess(actor, enrollment.leadId);
  else await assertContactAccess(actor, enrollment.contactId);
}

/** The pages to refresh after something happened to an enrollment. */
function revalidateSubject(enrollment: { leadId: string | null }) {
  revalidatePath(enrollment.leadId ? `/leads/${enrollment.leadId}` : "/contacts");
}

export async function createSequence(input: { name: string; description?: string }) {
  const actor = await getCurrentAccount();
  if (!actor || !canManageSequences(actor.role)) throw new Error("You are not authorized to create sequences");
  const sequence = await prisma.sequence.create({
    data: { name: input.name, description: input.description, createdById: actor.id },
  });
  revalidatePath("/sequences");
  return { sequenceId: sequence.id };
}

export async function toggleSequenceActive(sequenceId: string) {
  const actor = await getCurrentAccount();
  const seq = await assertSequenceAccess(actor, sequenceId);
  await prisma.sequence.update({ where: { id: sequenceId }, data: { isActive: !seq.isActive } });
  revalidatePath("/sequences");
  revalidatePath(`/sequences/${sequenceId}`);
}

/** Only Admin/Manager (canManageAllSequences), or the sequence's own
 * creator, may delete it — matches Part 12's "a user must not delete
 * another user's sequence unless role allows." */
export async function deleteSequence(sequenceId: string) {
  const actor = await getCurrentAccount();
  const sequence = await assertSequenceAccess(actor, sequenceId);
  if (sequence.createdById !== actor!.id && !canManageAllSequences(actor!.role)) {
    throw new Error("You are not authorized to delete this sequence");
  }
  await prisma.sequence.delete({ where: { id: sequenceId } });
  revalidatePath("/sequences");
}

const stepSchema = z.object({
  sequenceId: z.string(),
  subject: z.string().min(1),
  body: z.string().min(1),
  /** TEXT = the original plain text; HTML = the visual email editor. Omitted = TEXT, exactly as before. */
  bodyFormat: z.enum(["TEXT", "HTML"]).default("TEXT"),
  delayMinutes: z.number().min(0),
});

/**
 * What is stored for a step. An HTML step is cleaned on the SERVER (the browser's copy is never trusted) and judged: an error that would make the email unsendable or unsafe
 * (an unusable link, a picture recipients could never see, nothing to send, too large) stops the save and says why; warnings are advice shown in the editor, never a block. A
 * plain-text step is stored as it always was.
 */
function prepareStepContent(subject: string, body: string, bodyFormat: "TEXT" | "HTML"): { body: string; bodyFormat: "TEXT" | "HTML" } {
  if (bodyFormat === "TEXT") return { body, bodyFormat };
  const cleaned = sanitizeStepHtml(body);
  const analysis = analyzeStepContent({ subject, body, format: "HTML" }); // judged on what was written, so an unsafe link is reported rather than silently dropped
  if (!analysis.ok) throw new Error(`This email cannot be saved: ${analysis.errors[0].message}`);
  return { body: cleaned, bodyFormat };
}

export async function addStep(input: z.input<typeof stepSchema>) {
  const data = stepSchema.parse(input);
  const actor = await getCurrentAccount();
  await assertSequenceAccess(actor, data.sequenceId);
  const content = prepareStepContent(data.subject, data.body, data.bodyFormat);

  const count = await prisma.sequenceStep.count({ where: { sequenceId: data.sequenceId } });
  const step = await prisma.sequenceStep.create({
    data: { ...data, ...content, order: count },
  });
  revalidatePath(`/sequences/${data.sequenceId}`);
  return step;
}

export async function updateStep(stepId: string, patch: { subject?: string; body?: string; bodyFormat?: "TEXT" | "HTML"; delayMinutes?: number }) {
  const actor = await getCurrentAccount();
  const existingStep = await prisma.sequenceStep.findUniqueOrThrow({ where: { id: stepId }, select: { sequenceId: true, subject: true, body: true, bodyFormat: true } });
  await assertSequenceAccess(actor, existingStep.sequenceId);

  // Only the fields that were sent are changed (as before); a body or format change is cleaned and judged like a new step.
  const data: { subject?: string; body?: string; bodyFormat?: "TEXT" | "HTML"; delayMinutes?: number } = { ...patch };
  if (patch.body !== undefined || patch.bodyFormat !== undefined) {
    const format = patch.bodyFormat ?? existingStep.bodyFormat;
    const content = prepareStepContent(patch.subject ?? existingStep.subject, patch.body ?? existingStep.body, format);
    data.body = content.body;
    data.bodyFormat = content.bodyFormat;
  }
  const step = await prisma.sequenceStep.update({ where: { id: stepId }, data });
  revalidatePath(`/sequences/${step.sequenceId}`);
  return step;
}

/**
 * A copy of a step, added at the END of the sequence. Appending cannot change what anyone already in the sequence receives next (their position is a step number, and the
 * steps before the end keep theirs), so it is always safe; the copy can then be edited and, when nobody is part-way through, moved.
 */
export async function duplicateStep(stepId: string) {
  const actor = await getCurrentAccount();
  const source = await prisma.sequenceStep.findUniqueOrThrow({ where: { id: stepId } });
  await assertSequenceAccess(actor, source.sequenceId);
  const count = await prisma.sequenceStep.count({ where: { sequenceId: source.sequenceId } });
  const copy = await prisma.sequenceStep.create({
    data: { sequenceId: source.sequenceId, subject: source.subject, body: source.body, bodyFormat: source.bodyFormat, delayMinutes: source.delayMinutes, order: count },
  });
  revalidatePath(`/sequences/${source.sequenceId}`);
  return copy;
}

export type MoveStepResult = { ok: true } | { ok: false; error: string };

/**
 * Moves a step one place earlier or later. An enrollment records WHERE it is as a step number, so moving a step while people are part-way through would change what they
 * receive next (someone waiting for step 3 would suddenly be waiting for a different email, or be sent one twice). It is therefore only allowed while no enrollment is ACTIVE or
 * FAILED (waiting to be retried); the answer says so plainly instead of silently doing it.
 */
export async function moveStep(stepId: string, direction: "up" | "down"): Promise<MoveStepResult> {
  if (direction !== "up" && direction !== "down") return { ok: false, error: "Choose up or down." };
  const actor = await getCurrentAccount();
  const step = await prisma.sequenceStep.findUniqueOrThrow({ where: { id: stepId }, select: { id: true, sequenceId: true, order: true } });
  await assertSequenceAccess(actor, step.sequenceId);
  const inProgress = await prisma.sequenceEnrollment.count({ where: { sequenceId: step.sequenceId, status: { in: ["ACTIVE", "FAILED"] } } });
  if (inProgress > 0) {
    return { ok: false, error: `${inProgress === 1 ? "1 person is" : `${inProgress} people are`} part-way through this sequence, so steps cannot be reordered: it would change which email they receive next. Unenroll them or wait until they finish.` };
  }
  const steps = await prisma.sequenceStep.findMany({ where: { sequenceId: step.sequenceId }, orderBy: { order: "asc" }, select: { id: true } });
  const index = steps.findIndex((s) => s.id === stepId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= steps.length) return { ok: false, error: direction === "up" ? "This is already the first step." : "This is already the last step." };
  const reordered = steps.map((s) => s.id);
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  // Positions are rewritten for the whole sequence in one transaction, so there is never a moment with two steps in the same place.
  await prisma.$transaction(reordered.map((id, order) => prisma.sequenceStep.update({ where: { id }, data: { order } })));
  revalidatePath(`/sequences/${step.sequenceId}`);
  return { ok: true };
}

export async function deleteStep(stepId: string) {
  const actor = await getCurrentAccount();
  const existingStep = await prisma.sequenceStep.findUniqueOrThrow({ where: { id: stepId }, select: { sequenceId: true } });
  await assertSequenceAccess(actor, existingStep.sequenceId);

  const step = await prisma.sequenceStep.delete({ where: { id: stepId } });
  revalidatePath(`/sequences/${step.sequenceId}`);
}

/**
 * `recipientEmail` (Part 4) — the specific address(es) THIS enrollment's
 * automated sends should go to, chosen explicitly at enroll time when the
 * lead's contact has more than one on file (comma-separated when "both"
 * was picked). Only meaningful/exposed by the single-lead
 * ApplySequenceDialog today — the bulk EnrollLeadsDialog never passes it,
 * so every lead there keeps the pre-existing "use primaryEmail at send
 * time" behavior. Re-validated server-side against each lead's own
 * Contact emails regardless of caller, same as sendQuote's own recipient
 * re-check — never trust a client-supplied address blindly.
 */
/** Largest number of leads enrolled inside one database transaction (each takes its own advisory lock, always in sorted order). */
const ENROLL_CHUNK = 100;

export type EnrollLeadsResult = {
  /** Leads that now have a genuinely ACTIVE enrollment because of this call. */
  enrolled: number;
  /** Leads skipped because they already have an ACTIVE enrollment in this sequence (the meaning this field always had). */
  skipped: number;
  /** Per-reason counts of leads NOT enrolled; each lead is counted in exactly one bucket. */
  alreadyActive: number;
  missingEmail: number;
  /** Leads whose only usable address is on the do-not-email list (an unsubscribed or suppressed subscriber). */
  addressSuppressed: number;
  noAssignedAgent: number;
  gmailUnavailable: number;
  inaccessible: number;
  /** What happened to EVERY lead id that was asked about (after de-duplication), so callers never have to infer it from counts. */
  byLead: Record<string, "enrolled" | "alreadyActive" | "missingEmail" | "addressSuppressed" | "noAssignedAgent" | "gmailUnavailable" | "inaccessible">;
  error?: string;
  /** Set when at least one lead was refused because the account that sends its emails has no usable Gmail. */
  gmailProblem?: GmailProblemCode;
  /** The account whose Gmail was the problem (the lead's assigned agent): its id and name, never a token or an email address. */
  gmailSender?: { id: string; name: string };
  /** Plain-language explanation of gmailProblem. Never contains a token, key or provider error. */
  gmailMessage?: string;
};

/**
 * Enrolls leads in a sequence. A lead is enrolled only when its emails can actually be sent (see classifyLeadsForEnrollment, which also
 * powers the Sequences section's status-based preview), so an enrollment that exists is genuinely ACTIVE. Leads that fail a check are NOT
 * enrolled and no future send is scheduled for them; they are counted per reason in the result, and a failed-enrollment Activity row is
 * written for the Gmail case so the attempt stays in the lead's history. Only a genuinely ACTIVE enrollment blocks another enrollment in
 * the same sequence - FAILED, UNSUBSCRIBED and COMPLETED ones never do (a COMPLETED enrollment is therefore re-enrollable, which is how this
 * has always behaved). The duplicate check is repeated inside the transaction under a per-(sequence, lead) advisory lock, so two
 * simultaneous calls (double click, retry, two admins) cannot both create an ACTIVE enrollment for the same lead.
 *
 * `recipientEmail` (Part 4) - the specific address(es) THIS enrollment's automated sends should go to, chosen explicitly at enroll time
 * when the lead's contact has more than one on file (comma-separated when "both" was picked). Re-validated server-side against each
 * lead's own Contact emails regardless of caller - never trust a client-supplied address blindly.
 */
export async function enrollLeads(sequenceId: string, leadIds: string[], recipientEmail?: string, options?: { recipientMode?: RecipientMode }): Promise<EnrollLeadsResult> {
  // The mode comes from the browser: anything but the two known values is the safe default (primary only).
  const recipientMode: RecipientMode = isRecipientMode(options?.recipientMode) ? options!.recipientMode! : "primary";
  // Customer-email privacy: a raw recipient address from the browser is accepted only from a viewer who may see complete addresses. A restricted viewer's picker
  // (startSequenceForLead) sends opaque ids that the server resolves; accepting their raw address here would let the "is it on file?" check be used to probe.
  if (recipientEmail) {
    const actor = await getCurrentAccount();
    if (!actor || (await getEmailViewer(actor)).restricted) {
      return { enrolled: 0, skipped: 0, alreadyActive: 0, missingEmail: 0, addressSuppressed: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, byLead: {}, error: "Choose the recipients from the list." };
    }
  }
  return enrollLeadsCore(sequenceId, leadIds, recipientEmail, recipientMode);
}

async function enrollLeadsCore(sequenceId: string, leadIds: string[], recipientEmail?: string, recipientMode: RecipientMode = "primary"): Promise<EnrollLeadsResult> {
  const actor = await getCurrentAccount();
  await assertSequenceAccess(actor, sequenceId);
  // Per staff account (never per IP): generous for real work, a ceiling for a script or a stuck loop. Checked after authorization so an outsider cannot spend anyone's allowance.
  const limit = await checkAccountRateLimit(actor!.id, "SEQUENCE_ENROLL", RATE_LIMITS.SEQUENCE_ENROLL);
  if (!limit.allowed) {
    return {
      enrolled: 0, skipped: 0, alreadyActive: 0, missingEmail: 0, addressSuppressed: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, byLead: {},
      error: `Too many enrollment requests. Please try again in ${describeWait(limit.retryAfterSeconds)}.`,
    };
  }

  const sequence = await prisma.sequence.findUniqueOrThrow({
    where: { id: sequenceId },
    include: { steps: { orderBy: { order: "asc" }, take: 1 } },
  });
  const firstStep = sequence.steps[0];
  // The sequence pickers only offer active sequences, but this is a public server action: refuse here too, before any Gmail or lead lookups.
  if (!sequence.isActive) {
    return {
      enrolled: 0, skipped: 0, alreadyActive: 0, missingEmail: 0, addressSuppressed: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, byLead: {},
      error: "This sequence is inactive. Switch it to Active before enrolling leads.",
    };
  }

  const c = await classifyLeadsForEnrollment({ actor, sequenceId, leadIds, recipientEmail, recipientMode, verifyGmail: true });
  const count = (v: string) => [...c.verdicts.values()].filter((x) => x === v).length;
  const result: EnrollLeadsResult = {
    enrolled: 0,
    skipped: 0,
    alreadyActive: count("alreadyActive"),
    missingEmail: count("missingEmail"),
    addressSuppressed: count("addressSuppressed"),
    noAssignedAgent: count("noAssignedAgent"),
    gmailUnavailable: count("gmailUnavailable"),
    inaccessible: count("inaccessible"),
    byLead: {},
  };
  const eligible: string[] = [];
  for (const [id, v] of c.verdicts) {
    if (v === "eligible") eligible.push(id);
    else result.byLead[id] = v;
  }
  if (!firstStep) return { ...result, error: "This sequence has no steps yet" };
  if (c.blocked.length > 0) {
    result.gmailProblem = c.gmailProblem;
    result.gmailMessage = c.gmailMessage;
    result.gmailSender = { id: c.blocked[0].agent.id, name: c.blocked[0].agent.fullName };
    // The failed attempt stays in each lead's history; nothing is scheduled and no enrollment row is created.
    await prisma.activity.createMany({
      data: c.blocked.map((b) => ({
        leadId: b.leadId,
        actorId: actor?.id,
        type: "SEQUENCE_ENROLL_FAILED",
        description: `Could not enroll in sequence "${sequence.name}": Gmail is ${b.code === "NOT_CONNECTED" ? "not connected" : "not authorized"} for ${b.agent.fullName}, who sends this lead's emails`,
      })),
    });
  }

  // Lock each (sequence, lead) pair in sorted order, re-check for an ACTIVE enrollment created in the meantime, then create. Chunked so a
  // large selection never runs as one unbounded transaction.
  const createdLeadIds: string[] = [];
  const sortedEligible = eligible.sort();
  for (let i = 0; i < sortedEligible.length; i += ENROLL_CHUNK) {
    const chunk = sortedEligible.slice(i, i + ENROLL_CHUNK);
    const outcome = await prisma.$transaction(
      async (tx) => {
        for (const leadId of chunk) {
          // pg_advisory_xact_lock() returns `void`, which the Prisma PostgreSQL adapter cannot deserialize (P2010 UnsupportedNativeDataType: every enrolment failed on a
          // real PostgreSQL). Cast to text: the lock is taken exactly as before and held until this transaction ends.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${sequenceId}:${leadId}`}, 0))::text AS locked`;
        }
        // The same person enrolled WITHOUT a lead (contact-only) must not also be enrolled through a lead: the contact lock is the one a contact-only enrollment takes, always
        // after the lead locks and in sorted order (lead locks first, then contact locks), so the two paths can never deadlock.
        const contactIdsOfChunk = [...new Set(chunk.map((id) => c.contactByLead.get(id)).filter((x): x is string => !!x))].sort();
        for (const contactId of contactIdsOfChunk) {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${sequenceId}:contact:${contactId}`}, 0))::text AS locked`;
        }
        const taken = new Set(
          (await tx.sequenceEnrollment.findMany({ where: { sequenceId, leadId: { in: chunk }, status: "ACTIVE" }, select: { leadId: true } })).map((en) => en.leadId as string)
        );
        const contactOnly = new Set(
          (await tx.sequenceEnrollment.findMany({ where: { sequenceId, leadId: null, status: "ACTIVE", contactId: { in: contactIdsOfChunk } }, select: { contactId: true } })).map((en) => en.contactId)
        );
        for (const id of chunk) if (contactOnly.has(c.contactByLead.get(id) ?? "")) taken.add(id);
        const fresh = chunk.filter((id) => !taken.has(id));
        if (fresh.length > 0) {
          await tx.sequenceEnrollment.createMany({
            data: fresh.map((leadId) => ({
              sequenceId,
              leadId,
              contactId: c.contactByLead.get(leadId)!,
              enrolledById: actor?.id,
              nextSendAt: new Date(Date.now() + firstStep.delayMinutes * 60_000),
              recipientEmail: c.recipientByLead.get(leadId),
            })),
          });
          // Pass 35 - one batched createMany instead of N sequential logActivity() round-trips.
          await tx.activity.createMany({
            data: fresh.map((leadId) => ({
              leadId,
              actorId: actor?.id,
              type: "SEQUENCE_ENROLLED",
              description: `Enrolled in sequence "${sequence.name}"`,
            })),
          });
        }
        return { fresh, taken: [...taken] };
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
    createdLeadIds.push(...outcome.fresh);
    for (const id of outcome.fresh) result.byLead[id] = "enrolled";
    for (const id of outcome.taken) result.byLead[id] = "alreadyActive";
    result.alreadyActive += outcome.taken.length;
  }
  result.enrolled = createdLeadIds.length;
  result.skipped = result.alreadyActive;
  if (result.enrolled === 0 && result.gmailUnavailable > 0) result.error = result.gmailMessage;

  revalidatePath(`/sequences/${sequenceId}`);
  for (const leadId of createdLeadIds) revalidatePath(`/leads/${leadId}`);
  return result;
}

export type ContactEnrollOutcome = ContactVerdict | "enrolled";

export type EnrollContactsResult = {
  /** Contacts that now have a genuinely ACTIVE contact-only enrollment because of this call. */
  enrolled: number;
  /** Per-reason counts of contacts NOT enrolled; each contact is counted in exactly one bucket. */
  alreadyActive: number;
  missingEmail: number;
  addressSuppressed: number;
  gmailUnavailable: number;
  inaccessible: number;
  /** What happened to EVERY contact id that was asked about (after de-duplication), so callers never have to infer it from counts. */
  byContact: Record<string, ContactEnrollOutcome>;
  error?: string;
  gmailProblem?: GmailProblemCode;
  gmailSender?: { id: string; name: string };
  gmailMessage?: string;
};

const NO_CONTACT_RESULT: Omit<EnrollContactsResult, "error"> = { enrolled: 0, alreadyActive: 0, missingEmail: 0, addressSuppressed: 0, gmailUnavailable: 0, inaccessible: 0, byContact: {} };

/**
 * Enrolls CONTACTS in a sequence WITHOUT a lead: a contact is a customer or prospect in its own right and never needs an artificial lead to be emailed. The enrollment records
 * the contact (and no lead); the emails go out from the contact's owner, else from the person enrolling; every rule - who may see the contact, valid / de-duplicated /
 * do-not-email addresses (primary or all), a real Gmail check, one ACTIVE enrollment per person and sequence - is decided by classifyContactsForEnrollment, and the whole
 * thing is repeated under a per-(sequence, contact) advisory lock inside the transaction, so a double click or two admins cannot create two. Suppression is checked again at send
 * time (due-sequence-steps.ts). No lead is created, changed or looked at; nothing about the contact is modified.
 */
export async function enrollContacts(sequenceId: string, contactIds: string[], options?: { recipientMode?: RecipientMode }): Promise<EnrollContactsResult> {
  const recipientMode: RecipientMode = isRecipientMode(options?.recipientMode) ? options!.recipientMode! : "primary";
  const actor = await getCurrentAccount();
  await assertSequenceAccess(actor, sequenceId);
  const limit = await checkAccountRateLimit(actor!.id, "SEQUENCE_ENROLL", RATE_LIMITS.SEQUENCE_ENROLL);
  if (!limit.allowed) return { ...NO_CONTACT_RESULT, error: `Too many enrollment requests. Please try again in ${describeWait(limit.retryAfterSeconds)}.` };

  const sequence = await prisma.sequence.findUniqueOrThrow({ where: { id: sequenceId }, include: { steps: { orderBy: { order: "asc" }, take: 1 } } });
  const firstStep = sequence.steps[0];
  if (!sequence.isActive) return { ...NO_CONTACT_RESULT, error: "This sequence is inactive. Switch it to Active before enrolling contacts." };
  if (!firstStep) return { ...NO_CONTACT_RESULT, error: "This sequence has no steps yet" };

  const c = await classifyContactsForEnrollment({ actor: actor!, sequenceId, contactIds, recipientMode, verifyGmail: true });
  const result: EnrollContactsResult = { ...NO_CONTACT_RESULT, byContact: {} };
  const eligible: string[] = [];
  for (const [id, v] of c.verdicts) {
    if (v === "eligible") eligible.push(id);
    else result.byContact[id] = v;
  }
  if (c.blocked.length > 0) {
    result.gmailProblem = c.gmailProblem;
    result.gmailMessage = c.gmailMessage;
    if (c.gmailSender) result.gmailSender = { id: c.gmailSender.id, name: c.gmailSender.fullName };
    // The failed attempt stays in each contact's history; nothing is scheduled and no enrollment row is created.
    await prisma.activity.createMany({
      data: c.blocked.map((b) => ({
        contactId: b.contactId,
        actorId: actor?.id,
        type: "SEQUENCE_ENROLL_FAILED",
        description: `Could not enroll in sequence "${sequence.name}": Gmail is ${b.code === "NOT_CONNECTED" ? "not connected" : "not authorized"} for ${b.agent.fullName}, who sends this contact's emails`,
      })),
    });
  }

  const created: string[] = [];
  const sortedEligible = eligible.sort();
  for (let i = 0; i < sortedEligible.length; i += ENROLL_CHUNK) {
    const chunk = sortedEligible.slice(i, i + ENROLL_CHUNK);
    const outcome = await prisma.$transaction(
      async (tx) => {
        for (const contactId of chunk) {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${sequenceId}:contact:${contactId}`}, 0))::text AS locked`;
        }
        // ANY ACTIVE enrollment of the contact here (through a lead, or contact-only) blocks it. A lead-based enrollment of the same person created in the meantime holds the same
        // contact lock while it is created, so it is visible here.
        const taken = new Set(
          (await tx.sequenceEnrollment.findMany({ where: { sequenceId, status: "ACTIVE", contactId: { in: chunk } }, select: { contactId: true } })).map((en) => en.contactId)
        );
        const fresh = chunk.filter((id) => !taken.has(id));
        if (fresh.length > 0) {
          await tx.sequenceEnrollment.createMany({
            data: fresh.map((contactId) => ({
              sequenceId,
              contactId,
              leadId: null,
              enrolledById: actor?.id,
              nextSendAt: new Date(Date.now() + firstStep.delayMinutes * 60_000),
              recipientEmail: c.recipientByContact.get(contactId),
            })),
          });
          await tx.activity.createMany({
            data: fresh.map((contactId) => ({ contactId, actorId: actor?.id, type: "SEQUENCE_ENROLLED", description: `Enrolled in sequence "${sequence.name}"` })),
          });
        }
        return { fresh, taken: [...taken] };
      },
      { timeout: 30_000, maxWait: 10_000 }
    );
    created.push(...outcome.fresh);
    for (const id of outcome.fresh) result.byContact[id] = "enrolled";
    for (const id of outcome.taken) result.byContact[id] = "alreadyActive";
  }
  const count = (v: ContactEnrollOutcome) => Object.values(result.byContact).filter((x) => x === v).length;
  result.enrolled = created.length;
  result.alreadyActive = count("alreadyActive");
  result.missingEmail = count("missingEmail");
  result.addressSuppressed = count("addressSuppressed");
  result.gmailUnavailable = count("gmailUnavailable");
  result.inaccessible = count("inaccessible");
  if (result.enrolled === 0 && result.gmailUnavailable > 0) result.error = result.gmailMessage;

  if (created.length > 0) {
    // One append-only audit entry per batch: who, which sequence, how many (never an address, a name or a subject).
    await prisma.auditLog
      .create({ data: { actorId: actor?.id ?? null, action: "SEQUENCE_CONTACTS_ENROLLED", entityType: "Sequence", entityId: sequenceId, metadata: { contactOnly: true, enrolled: created.length, requested: contactIds.length, recipientMode } } })
      .catch((err: unknown) => console.error("[enroll-contacts] audit write failed", err instanceof Error ? err.name : "error"));
  }
  revalidatePath(`/sequences/${sequenceId}`);
  revalidatePath("/contacts");
  return result;
}

/** Why Gmail blocks a start/retry, in terms the UI can act on. */
export type GmailBlock = {
  problem: GmailProblemCode;
  /** true: the user must (re)connect Gmail; false: temporary - do NOT say "connect Gmail". */
  needsReconnect: boolean;
  /** Name of the agent whose Gmail sends this lead's emails. */
  senderName: string;
  /** true when that agent is the person looking at the lead (so they can connect Gmail themselves from here). */
  senderIsViewer: boolean;
};

export type SequenceStartReadiness =
  | { ok: true; sequenceName: string; senderName: string; senderIsViewer: boolean }
  | { ok: false; code: "GMAIL_UNAVAILABLE" | "ALREADY_ENROLLED" | "NOT_ELIGIBLE" | "SEQUENCE_INACTIVE" | "ERROR"; error: string; gmail?: GmailBlock };

/**
 * "Can this lead be put into this sequence right now?" - asked when the user CHOOSES a sequence, before the confirmation is shown, and again by the
 * approval itself. It changes nothing: no enrollment, no activity row, no email. It verifies the sending account's Gmail for real (a token refresh against
 * Google, no mail is sent), so "connected" on a settings page is never taken on trust, and it tells apart: not connected / expired or revoked / send
 * permission missing / Google temporarily unreachable.
 */
export async function getSequenceStartReadiness(sequenceId: string, leadId: string): Promise<SequenceStartReadiness> {
  if (typeof sequenceId !== "string" || !sequenceId || typeof leadId !== "string" || !leadId) return { ok: false, code: "ERROR", error: "That sequence is not available." };
  const actor = await getCurrentAccount();
  let sequence;
  try {
    sequence = await assertSequenceAccess(actor, sequenceId);
  } catch {
    return { ok: false, code: "ERROR", error: "That sequence is not available." };
  }
  if (!sequence.isActive) return { ok: false, code: "SEQUENCE_INACTIVE", error: "This sequence is inactive. Switch it to Active before enrolling leads." };
  const stepCount = await prisma.sequenceStep.count({ where: { sequenceId } });
  if (stepCount === 0) return { ok: false, code: "ERROR", error: "This sequence has no steps yet." };

  const c = await classifyLeadsForEnrollment({ actor, sequenceId, leadIds: [leadId], verifyGmail: true });
  const verdict = c.verdicts.get(leadId);
  if (verdict === "alreadyActive") return { ok: false, code: "ALREADY_ENROLLED", error: "This lead is already actively enrolled in that sequence." };
  if (verdict === "missingEmail") return { ok: false, code: "NOT_ELIGIBLE", error: "This lead has no email address, so a sequence cannot be applied. Add one to the contact first." };
  if (verdict === "addressSuppressed") return { ok: false, code: "NOT_ELIGIBLE", error: "This lead's email address has unsubscribed or is suppressed (a bounce or complaint), so it cannot receive a sequence. Update the contact's email first." };
  if (verdict === "noAssignedAgent") return { ok: false, code: "NOT_ELIGIBLE", error: "This lead has no assigned agent to send the emails from. Assign an agent first." };
  if (verdict === "inaccessible" || verdict === undefined) return { ok: false, code: "NOT_ELIGIBLE", error: "That lead is not available." };
  if (verdict === "gmailUnavailable" && c.blocked[0]) {
    const blocked = c.blocked[0];
    return {
      ok: false,
      code: "GMAIL_UNAVAILABLE",
      error: describeGmailProblem(blocked.code, blocked.agent, actor?.id),
      gmail: { problem: blocked.code, needsReconnect: gmailProblemNeedsReconnect(blocked.code), senderName: blocked.agent.fullName, senderIsViewer: blocked.agent.id === actor?.id },
    };
  }
  const lead = await prisma.lead.findFirst({ where: { id: leadId }, select: { assignedAgent: { select: { id: true, fullName: true } } } });
  return { ok: true, sequenceName: sequence.name, senderName: lead?.assignedAgent?.fullName ?? "the assigned agent", senderIsViewer: lead?.assignedAgent?.id === actor?.id };
}

export type StartSequenceResult =
  | {
      ok: true;
      sequenceName: string;
      /** sent: step 1 went out now. scheduled: step 1 has a configured delay and will go out automatically at nextSendAt. retrying: step 1 could not be sent
       * just now (a temporary problem) and will be retried automatically at nextSendAt. unconfirmed: Gmail did not say whether step 1 was sent; it was NOT
       * resent, and a person has to confirm (see resolveUncertainDelivery). */
      firstStep: "sent" | "scheduled" | "retrying" | "unconfirmed";
      nextSendAt: string | null;
      /** Plain-language reason for "retrying"/"unconfirmed"; never a token, key or raw provider payload. */
      note?: string;
    }
  | { ok: false; error: string; code: "GMAIL_UNAVAILABLE" | "ALREADY_ENROLLED" | "NOT_ELIGIBLE" | "SEQUENCE_INACTIVE" | "SEND_FAILED" | "ERROR"; gmail?: GmailBlock };

const FIRST_SEND_FAILURE_FALLBACK = "the email could not be sent";
function shortReason(error: string | null | undefined): string {
  const text = (error ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 160) : FIRST_SEND_FAILURE_FALLBACK;
}

type SendOutcome =
  | { kind: "sent"; nextSendAt: string | null }
  | { kind: "scheduled"; nextSendAt: string | null }
  | { kind: "retrying"; nextSendAt: string | null; note: string }
  | { kind: "unconfirmed"; note: string }
  | { kind: "failed"; error: string };

/** What the enrollment looks like now, read back from the database after a send attempt: the single place that turns stored state into an outcome. */
async function readSendOutcome(enrollmentId: string): Promise<SendOutcome | null> {
  const after = await prisma.sequenceEnrollment.findUnique({
    where: { id: enrollmentId },
    select: {
      status: true,
      currentStepIdx: true,
      nextSendAt: true,
      sequence: { select: { steps: { orderBy: { order: "asc" }, select: { id: true } } } },
      stepLogs: { orderBy: { createdAt: "desc" }, select: { id: true, stepId: true, status: true, error: true, createdAt: true } },
    },
  });
  if (!after) return null;
  const nextSendAt = after.nextSendAt ? after.nextSendAt.toISOString() : null;
  const stepId = after.sequence.steps[after.currentStepIdx]?.id;
  const stepLogs = after.stepLogs.filter((l) => l.stepId === stepId);
  const open = openDelivery(stepLogs);
  if (after.status === "ACTIVE" && open) return { kind: "unconfirmed", note: shortReason(markerReason(open.log.error)) };
  const lastReal = stepLogs.find((l) => l.status === "FAILED" && !/^(IN_FLIGHT|UNCERTAIN|RETRY_EPOCH|RESOLVED):/.test(l.error ?? ""));
  if (after.status === "FAILED") return { kind: "failed", error: shortReason(lastReal?.error) };
  if (after.status === "COMPLETED" || after.currentStepIdx > 0) return { kind: "sent", nextSendAt };
  if (lastReal) return { kind: "retrying", nextSendAt, note: shortReason(lastReal.error) };
  return { kind: "scheduled", nextSendAt };
}

async function gmailBlockFor(agent: { id: string; fullName: string }, code: GmailProblemCode, actorId: string | undefined): Promise<{ error: string; gmail: GmailBlock }> {
  return {
    error: describeGmailProblem(code, agent, actorId),
    gmail: { problem: code, needsReconnect: gmailProblemNeedsReconnect(code), senderName: agent.fullName, senderIsViewer: agent.id === actorId },
  };
}

/**
 * The one-step "Approve and start" action behind the lead's Apply Sequence confirmation. It enrolls the lead (every enrollLeads rule applies unchanged:
 * authorization, company scoping, active sequence, a REAL Gmail check of the sending account, valid recipient, one ACTIVE enrollment per lead and sequence,
 * unsubscribe/suppression behaviour) and, when the first step is due now, sends it IMMEDIATELY through the same claim-and-send path the scheduler uses - the
 * user never has to find a "process due" button. A step with a delay is left to the scheduler, which sends it at the right time without anyone opening a page.
 *
 * Honest results, never a success that did not happen:
 *   - Gmail unusable (not connected / expired / permission missing / Google unreachable): NOTHING is created - no enrollment, no schedule, no email - and the
 *     reason is returned so the lead page can say what to do;
 *   - a definite first-send failure that is not retryable (Gmail revoked between the check and the send) leaves the enrollment FAILED and visible in the lead's
 *     history, and is returned as a failure; it can be restarted in place once Gmail is back (retryEnrollmentNow), without a second enrollment;
 *   - a temporary failure leaves the enrollment ACTIVE with a retry already scheduled and is returned as "retrying" with the time;
 *   - no answer from Gmail is NOT treated as "not sent": it is returned as "unconfirmed" and the email is not resent until a person decides;
 *   - a repeated click or a retry after a network drop cannot send step 1 twice: enrollLeads refuses a second ACTIVE enrollment (ALREADY_ENROLLED), the send
 *     is claimed atomically, and a send that already started is recorded before the request leaves (lib/sequence-delivery.ts).
 */
export async function startSequenceForLead(sequenceId: string, leadId: string, recipientEmail?: string, recipientIds?: string[]): Promise<StartSequenceResult> {
  if (typeof sequenceId !== "string" || !sequenceId || typeof leadId !== "string" || !leadId) return { ok: false, code: "ERROR", error: "The sequence could not be applied to this lead." };

  // Customer-email privacy: a viewer who may only see masked addresses names the recipients by opaque id; the server resolves them (and a restricted viewer may not
  // supply a raw address at all - that would be a way to probe which addresses are on file).
  if (recipientIds || recipientEmail) {
    const actor = await getCurrentAccount();
    if (!actor) return { ok: false, code: "ERROR", error: "The sequence could not be applied to this lead." };
    const lead = await prisma.lead.findFirst({ where: { id: leadId, ...leadVisibilityWhere(actor) }, select: { contactId: true } });
    if (!lead) return { ok: false, code: "ERROR", error: "The sequence could not be applied to this lead." };
    try {
      recipientEmail = await resolveSendRecipients(await getEmailViewer(actor), lead.contactId, { to: recipientEmail, recipientIds });
    } catch {
      return { ok: false, code: "ERROR", error: "Choose the recipients from the list." };
    }
  }

  const r = await enrollLeadsCore(sequenceId, [leadId], recipientEmail);
  if (r.error) {
    if (r.gmailProblem && r.gmailSender) {
      const actor = await getCurrentAccount();
      return { ok: false, code: "GMAIL_UNAVAILABLE", error: r.error, gmail: { problem: r.gmailProblem, needsReconnect: gmailProblemNeedsReconnect(r.gmailProblem), senderName: r.gmailSender.name, senderIsViewer: r.gmailSender.id === actor?.id } };
    }
    return { ok: false, code: /inactive/i.test(r.error) ? "SEQUENCE_INACTIVE" : "ERROR", error: r.error };
  }
  if (r.enrolled === 0) {
    if (r.alreadyActive > 0) return { ok: false, code: "ALREADY_ENROLLED", error: "This lead is already actively enrolled in that sequence." };
    const error =
      r.missingEmail > 0
        ? "This lead has no email address, so a sequence cannot be applied. Add one to the contact first."
        : r.addressSuppressed > 0
          ? "This lead's email address has unsubscribed or is suppressed (a bounce or complaint), so it cannot receive a sequence. Update the contact's email first."
        : r.noAssignedAgent > 0
          ? "This lead has no assigned agent to send the emails from. Assign an agent first."
          : r.inaccessible > 0
            ? "That lead is not available."
            : "The sequence could not be applied to this lead.";
    return { ok: false, code: "NOT_ELIGIBLE", error };
  }

  const created = await prisma.sequenceEnrollment.findFirst({
    where: { sequenceId, leadId, status: "ACTIVE" },
    orderBy: { enrolledAt: "desc" },
    select: { id: true, nextSendAt: true, sequence: { select: { name: true } } },
  });
  if (!created) return { ok: false, code: "ERROR", error: "The sequence could not be applied to this lead." };
  const sequenceName = created.sequence.name;

  // Step 1 is due now (no delay): send it right away. Otherwise the scheduler sends it at nextSendAt.
  if (created.nextSendAt && created.nextSendAt.getTime() <= Date.now()) {
    await runDueSequenceSteps({ enrollmentIds: [created.id] });
  }

  const outcome = await readSendOutcome(created.id);
  revalidatePath(`/leads/${leadId}`);
  revalidatePath(`/sequences/${sequenceId}`);
  if (!outcome) return { ok: false, code: "ERROR", error: "The sequence could not be applied to this lead." };
  switch (outcome.kind) {
    case "failed":
      return { ok: false, code: "SEND_FAILED", error: `The sequence was not started: ${outcome.error}.` };
    case "sent":
      return { ok: true, sequenceName, firstStep: "sent", nextSendAt: outcome.nextSendAt };
    case "retrying":
      return { ok: true, sequenceName, firstStep: "retrying", nextSendAt: outcome.nextSendAt, note: outcome.note };
    case "unconfirmed":
      return { ok: true, sequenceName, firstStep: "unconfirmed", nextSendAt: null, note: outcome.note };
    default:
      return { ok: true, sequenceName, firstStep: "scheduled", nextSendAt: outcome.nextSendAt };
  }
}

export type RecoveryResult =
  | { ok: true; outcome: "sent" | "scheduled" | "retrying" | "unconfirmed" | "recorded"; nextSendAt: string | null; note?: string }
  | { ok: false; error: string; gmail?: GmailBlock };

const SENDER_SELECT = { id: true, fullName: true, email: true, phone: true, companyId: true } as const;

/** Loads what a recovery action needs about one enrollment, after the usual sequence-access and ownership checks. `leadId` (the lead page) must match when given; a contact-only enrollment has none (null). */
async function loadForRecovery(enrollmentId: string, leadId: string | null | undefined) {
  const actor = await getCurrentAccount();
  const existing = await prisma.sequenceEnrollment.findUnique({
    where: { id: enrollmentId },
    select: {
      id: true,
      sequenceId: true,
      leadId: true,
      contactId: true,
      status: true,
      currentStepIdx: true,
      nextSendAt: true,
      sequence: { select: { name: true, isActive: true, steps: { orderBy: { order: "asc" }, select: { id: true, delayMinutes: true } } } },
      lead: { select: { assignedAgent: { select: SENDER_SELECT } } },
      contact: { select: { owner: { select: SENDER_SELECT } } },
      enrolledBy: { select: SENDER_SELECT },
    },
  });
  if (!existing) throw new Error(SEQUENCE_NOT_FOUND);
  await assertSequenceAccess(actor, existing.sequenceId);
  if (leadId !== undefined && existing.leadId !== leadId) throw new Error(SEQUENCE_NOT_FOUND);
  await assertEnrollmentSubjectAccess(actor!, existing);
  const step = existing.sequence.steps[existing.currentStepIdx];
  const logs = step ? await prisma.sequenceStepLog.findMany({ where: { enrollmentId, stepId: step.id }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, error: true, createdAt: true } }) : [];
  return { actor, existing, step, logs };
}

/** Verifies the sending account is ready (a real token check) before any recovery sends anything. */
async function recoveryGmailCheck(existing: Awaited<ReturnType<typeof loadForRecovery>>["existing"], actorCompanyId: string | undefined, actorId: string | undefined): Promise<RecoveryResult | null> {
  const agent = enrollmentSender({ ...existing, lead: existing.lead, contact: existing.contact });
  if (!agent) return { ok: false, error: existing.leadId ? "This lead has no assigned agent to send the emails from. Assign an agent first." : "Nobody is set up to send this contact's emails: the contact has no owner. Assign an owner first." };
  if (actorCompanyId && agent.companyId !== actorCompanyId) return { ok: false, error: existing.leadId ? "That lead is not available." : "That contact is not available." };
  const readiness = await checkGmailSendReadiness(agent.id, { verifyToken: true });
  if (readiness.ready) return null;
  return { ok: false, ...(await gmailBlockFor(agent, readiness.code, actorId)) };
}

async function recoveryOutcome(enrollmentId: string, sequenceId: string, leadId: string | null): Promise<RecoveryResult> {
  const outcome = await readSendOutcome(enrollmentId);
  revalidateSubject({ leadId });
  revalidatePath(`/sequences/${sequenceId}`);
  if (!outcome) return { ok: false, error: "The result could not be read. Refresh the page." };
  if (outcome.kind === "failed") return { ok: false, error: `The email was not sent: ${outcome.error}.` };
  if (outcome.kind === "unconfirmed") return { ok: true, outcome: "unconfirmed", nextSendAt: null, note: outcome.note };
  return outcome.kind === "retrying" ? { ok: true, outcome: "retrying", nextSendAt: outcome.nextSendAt, note: outcome.note } : { ok: true, outcome: outcome.kind, nextSendAt: outcome.nextSendAt };
}

/**
 * "Retry now" for an enrollment that is waiting for a retry (ACTIVE, last attempt failed temporarily) or that gave up (FAILED): the SAME enrollment is
 * restarted - never a second one. Gmail is verified first; if it is not usable nothing changes and the reason is returned. A restart of a FAILED enrollment
 * writes a RETRY_EPOCH marker so the automatic-retry limit starts fresh. It refuses while a delivery of that step is unconfirmed: that must be resolved with
 * resolveUncertainDelivery, because the email may already have been sent.
 */
export async function retryEnrollmentNow(enrollmentId: string, leadId?: string | null): Promise<RecoveryResult> {
  const { actor, existing, step, logs } = await loadForRecovery(enrollmentId, leadId);
  const limit = await checkAccountRateLimit(actor!.id, "SEQUENCE_RECOVERY", RATE_LIMITS.SEQUENCE_RECOVERY);
  if (!limit.allowed) return { ok: false, error: `Too many retries. Please try again in ${describeWait(limit.retryAfterSeconds)}.` };
  if (existing.status !== "ACTIVE" && existing.status !== "FAILED") return { ok: false, error: "This enrollment is no longer active, so there is nothing to retry." };
  if (!existing.sequence.isActive) return { ok: false, error: "This sequence is switched off. Switch it on to continue." };
  if (!step) return { ok: false, error: "This enrollment has no step left to send." };
  if (openDelivery(logs)) return { ok: false, error: "Delivery of this step was not confirmed, so it will not be sent again automatically. Choose 'It was sent' or 'Send again' instead." };

  const blocked = await recoveryGmailCheck(existing, actor?.companyId, actor?.id);
  if (blocked) return blocked;

  if (existing.status === "FAILED") {
    await prisma.sequenceStepLog.create({ data: { enrollmentId, stepId: step.id, status: "FAILED", error: `${RETRY_EPOCH_PREFIX} restarted by ${actor?.fullName ?? "a user"}` } });
    const reopened = await prisma.sequenceEnrollment.updateMany({ where: { id: enrollmentId, status: "FAILED" }, data: { status: "ACTIVE", completedAt: null, nextSendAt: new Date() } });
    if (reopened.count === 0) return { ok: false, error: "This enrollment changed while you were looking at it. Refresh the page." };
  } else {
    // Conditional on the time we read: if a worker claimed it in the meantime (its lease moved nextSendAt), do not step on it.
    const due = await prisma.sequenceEnrollment.updateMany({ where: { id: enrollmentId, status: "ACTIVE", nextSendAt: existing.nextSendAt }, data: { nextSendAt: new Date() } });
    if (due.count === 0) return { ok: false, error: "This email is being processed right now. Refresh the page in a moment." };
  }
  await logActivity({ ...activitySubject(existing), actorId: actor?.id, type: "SEQUENCE_RETRIED", description: `Retried step ${existing.currentStepIdx + 1} of sequence "${existing.sequence.name}"` });
  await runDueSequenceSteps({ enrollmentIds: [enrollmentId] });
  return recoveryOutcome(enrollmentId, existing.sequenceId, existing.leadId);
}

/**
 * A person's decision about a step whose delivery is UNCONFIRMED (Gmail gave no answer, or a send started and never reported back). The CRM cannot ask
 * Gmail whether the message went out (it only holds the send permission), so it never guesses:
 *   "sent"   - the person checked the sender's Sent folder and the email is there: the step is recorded as sent and the sequence moves on.
 *   "resend" - it is not there (or they accept a possible duplicate): Gmail is verified, the step is sent again.
 * Both are audited with who decided.
 */
export async function resolveUncertainDelivery(enrollmentId: string, decision: "sent" | "resend", leadId?: string | null): Promise<RecoveryResult> {
  if (decision !== "sent" && decision !== "resend") return { ok: false, error: "Choose 'It was sent' or 'Send again'." };
  const { actor, existing, step, logs } = await loadForRecovery(enrollmentId, leadId);
  const limit = await checkAccountRateLimit(actor!.id, "SEQUENCE_RECOVERY", RATE_LIMITS.SEQUENCE_RECOVERY);
  if (!limit.allowed) return { ok: false, error: `Too many requests. Please try again in ${describeWait(limit.retryAfterSeconds)}.` };
  const open = openDelivery(logs);
  if (existing.status !== "ACTIVE" || !step || !open) return { ok: false, error: "There is no unconfirmed delivery to resolve for this enrollment." };
  if (open.kind === "IN_FLIGHT" && isRecentInFlight(open.log)) return { ok: false, error: "An email is still being sent. Wait a minute and refresh the page." };
  if (!open.log.id) return { ok: false, error: "There is no unconfirmed delivery to resolve for this enrollment." };
  const who = actor?.fullName ?? "a user";

  // Only a person can resolve, and only an UNKNOWN attempt (a stale in-flight one counts as unknown): UNKNOWN -> SENT or UNKNOWN -> SUPERSEDED.
  assertTransition("UNKNOWN", decision === "sent" ? "SENT" : "SUPERSEDED");
  if (decision === "sent") {
    const nextIdx = existing.currentStepIdx + 1;
    const nextStep = existing.sequence.steps[nextIdx];
    await prisma.sequenceStepLog.update({ where: { id: open.log.id }, data: { status: "SENT", sentAt: new Date(), error: null } });
    await prisma.sequenceEnrollment.updateMany({
      where: { id: enrollmentId, status: "ACTIVE" },
      data: nextStep ? { currentStepIdx: nextIdx, nextSendAt: new Date(Date.now() + nextStep.delayMinutes * 60_000) } : { status: "COMPLETED", completedAt: new Date(), nextSendAt: null, currentStepIdx: nextIdx },
    });
    await logActivity({ ...activitySubject(existing), actorId: actor?.id, type: "SEQUENCE_DELIVERY_CONFIRMED", description: `${who} confirmed that step ${existing.currentStepIdx + 1} of sequence "${existing.sequence.name}" was sent` });
    revalidateSubject(existing);
    revalidatePath(`/sequences/${existing.sequenceId}`);
    return { ok: true, outcome: "recorded", nextSendAt: nextStep ? new Date(Date.now() + nextStep.delayMinutes * 60_000).toISOString() : null };
  }

  const blocked = await recoveryGmailCheck(existing, actor?.companyId, actor?.id);
  if (blocked) return blocked;
  await prisma.sequenceStepLog.update({ where: { id: open.log.id }, data: { error: `${RESOLVED_PREFIX} sent again by ${who} after an unconfirmed delivery` } });
  const reopened = await prisma.sequenceEnrollment.updateMany({ where: { id: enrollmentId, status: "ACTIVE", nextSendAt: null }, data: { nextSendAt: new Date() } });
  if (reopened.count === 0) return { ok: false, error: "This enrollment changed while you were looking at it. Refresh the page." };
  await logActivity({ ...activitySubject(existing), actorId: actor?.id, type: "SEQUENCE_DELIVERY_RESENT", description: `${who} chose to send step ${existing.currentStepIdx + 1} of sequence "${existing.sequence.name}" again after an unconfirmed delivery` });
  await runDueSequenceSteps({ enrollmentIds: [enrollmentId] });
  return recoveryOutcome(enrollmentId, existing.sequenceId, existing.leadId);
}

/**
 * Stops an ACTIVE or FAILED enrollment (a FAILED one is a stuck enrollment - Gmail expired, retries used up - that a person decides to end instead of retrying):
 * it becomes UNSUBSCRIBED with stopReason UNENROLLED, who and when, and nextSendAt is cleared, so the sequence worker no longer sees it as due; the worker also
 * re-confirms ACTIVE atomically right before each send (see processDueSequenceSteps), so a job already in flight cannot send after this commits. Every remaining
 * step shows as cancelled and the sent-email history is kept. A COMPLETED / UNSUBSCRIBED / REPLIED one is left exactly as it is. When `leadId` is given (the lead
 * profile), the enrollment must belong to that lead. Authorization is the existing sequence rule (assertSequenceAccess) plus access to the lead; the action is
 * written to the lead's Activity history AND to the append-only audit log (who, which enrollment, why).
 */
export async function unenrollLead(enrollmentId: string, leadId?: string | null): Promise<{ ok: boolean; error?: string }> {
  const actor = await getCurrentAccount();
  const existing = await prisma.sequenceEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { id: true, sequenceId: true, leadId: true, contactId: true, sequence: { select: { name: true } } },
  });
  if (!existing) throw new Error(SEQUENCE_NOT_FOUND);
  const sequence = await assertSequenceAccess(actor, existing.sequenceId);
  // Same generic answer as a missing enrollment: a caller learns nothing about enrollments that are not theirs to touch.
  if (leadId !== undefined && existing.leadId !== leadId) throw new Error(SEQUENCE_NOT_FOUND);
  await assertEnrollmentSubjectAccess(actor!, existing);

  const before = await prisma.sequenceEnrollment.findUnique({ where: { id: enrollmentId }, select: { status: true, currentStepIdx: true } });
  const stopped = await prisma.sequenceEnrollment.updateMany({
    where: { id: enrollmentId, status: { in: ["ACTIVE", "FAILED"] } },
    data: { status: "UNSUBSCRIBED", nextSendAt: null, waitReason: null, stopReason: "UNENROLLED", stoppedAt: new Date(), stoppedById: actor?.id ?? null },
  });
  if (stopped.count === 0) return { ok: false, error: "This enrollment is no longer active." };

  await logActivity({
    ...activitySubject(existing),
    actorId: actor?.id,
    type: "SEQUENCE_UNENROLLED",
    description: `Removed from sequence "${existing.sequence?.name ?? sequence.name}"${before?.status === "FAILED" ? " (it had failed)" : ""}`,
  });
  // Append-only audit trail: who ended which enrollment and in what state it was. No address, subject or body.
  await prisma.auditLog
    .create({ data: { actorId: actor?.id ?? null, action: "SEQUENCE_ENROLLMENT_UNENROLLED", entityType: "SequenceEnrollment", entityId: enrollmentId, metadata: { sequenceId: existing.sequenceId, leadId: existing.leadId, contactId: existing.contactId, previousStatus: before?.status ?? null, atStep: (before?.currentStepIdx ?? 0) + 1 } } })
    .catch((err: unknown) => console.error("[unenroll] audit write failed", err instanceof Error ? err.name : "error"));
  revalidatePath(`/sequences/${existing.sequenceId}`);
  revalidateSubject(existing);
  return { ok: true };
}
