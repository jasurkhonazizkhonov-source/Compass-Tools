"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { logActivity } from "@/server/activity-log";
import { sendEmail } from "@/server/email/service";
import { buildSequenceEmail } from "@/server/email/templates";
import { renderSequenceTemplate, type SequenceVariableContext } from "@/lib/sequence-variables";
import { getCompanyForAccountId } from "@/server/queries/company";
import { canManageSequences, canManageAllSequences } from "@/lib/permissions";
import { sequenceVisibilityWhere, leadVisibilityWhere } from "@/server/visibility";
import { resolveBaseUrl } from "@/lib/company-config";

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
  delayMinutes: z.number().min(0),
});

export async function addStep(input: z.infer<typeof stepSchema>) {
  const data = stepSchema.parse(input);
  const actor = await getCurrentAccount();
  await assertSequenceAccess(actor, data.sequenceId);

  const count = await prisma.sequenceStep.count({ where: { sequenceId: data.sequenceId } });
  const step = await prisma.sequenceStep.create({
    data: { ...data, order: count },
  });
  revalidatePath(`/sequences/${data.sequenceId}`);
  return step;
}

export async function updateStep(stepId: string, patch: { subject?: string; body?: string; delayMinutes?: number }) {
  const actor = await getCurrentAccount();
  const existingStep = await prisma.sequenceStep.findUniqueOrThrow({ where: { id: stepId }, select: { sequenceId: true } });
  await assertSequenceAccess(actor, existingStep.sequenceId);

  const step = await prisma.sequenceStep.update({ where: { id: stepId }, data: patch });
  revalidatePath(`/sequences/${step.sequenceId}`);
  return step;
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
export async function enrollLeads(sequenceId: string, leadIds: string[], recipientEmail?: string) {
  const actor = await getCurrentAccount();
  await assertSequenceAccess(actor, sequenceId);
  // A lead can only be enrolled by someone who can actually see it — never
  // trust a client-supplied leadIds array blindly.
  const visibleLeadIds = new Set(
    (await prisma.lead.findMany({ where: { id: { in: leadIds }, ...leadVisibilityWhere(actor) }, select: { id: true } })).map((l) => l.id)
  );
  leadIds = leadIds.filter((id) => visibleLeadIds.has(id));

  const sequence = await prisma.sequence.findUniqueOrThrow({
    where: { id: sequenceId },
    include: { steps: { orderBy: { order: "asc" }, take: 1 } },
  });
  const firstStep = sequence.steps[0];
  if (!firstStep) return { enrolled: 0, error: "This sequence has no steps yet" };

  const existing = await prisma.sequenceEnrollment.findMany({
    where: { sequenceId, leadId: { in: leadIds }, status: "ACTIVE" },
    select: { leadId: true },
  });
  const alreadyEnrolled = new Set(existing.map((e) => e.leadId));
  const toEnroll = leadIds.filter((id) => !alreadyEnrolled.has(id));

  // Resolve the validated recipientEmail per lead (rather than trusting the
  // caller) only when one was actually requested — the common bulk-enroll
  // path skips this query entirely.
  const recipientByLead = new Map<string, string>();
  if (recipientEmail && toEnroll.length > 0) {
    const requested = recipientEmail.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
    const leadsWithContacts = await prisma.lead.findMany({
      where: { id: { in: toEnroll } },
      select: { id: true, contact: { select: { primaryEmail: true, emails: { select: { email: true } } } } },
    });
    for (const lead of leadsWithContacts) {
      const known = new Set(
        [lead.contact.primaryEmail, ...lead.contact.emails.map((e) => e.email)].filter((e): e is string => !!e).map((e) => e.toLowerCase())
      );
      const validated = requested.filter((r) => known.has(r));
      if (validated.length > 0) recipientByLead.set(lead.id, validated.join(", "));
    }
  }

  if (toEnroll.length > 0) {
    await prisma.sequenceEnrollment.createMany({
      data: toEnroll.map((leadId) => ({
        sequenceId,
        leadId,
        enrolledById: actor?.id,
        nextSendAt: new Date(Date.now() + firstStep.delayMinutes * 60_000),
        recipientEmail: recipientByLead.get(leadId),
      })),
    });
    for (const leadId of toEnroll) {
      await logActivity({
        leadId,
        actorId: actor?.id,
        type: "SEQUENCE_ENROLLED",
        description: `Enrolled in sequence "${sequence.name}"`,
      });
    }
  }

  revalidatePath(`/sequences/${sequenceId}`);
  for (const leadId of toEnroll) revalidatePath(`/leads/${leadId}`);
  return { enrolled: toEnroll.length, skipped: leadIds.length - toEnroll.length };
}

export async function unenrollLead(enrollmentId: string) {
  const actor = await getCurrentAccount();
  const existingEnrollment = await prisma.sequenceEnrollment.findUniqueOrThrow({ where: { id: enrollmentId }, select: { sequenceId: true } });
  await assertSequenceAccess(actor, existingEnrollment.sequenceId);

  const enrollment = await prisma.sequenceEnrollment.update({
    where: { id: enrollmentId },
    data: { status: "UNSUBSCRIBED" },
  });
  revalidatePath(`/sequences/${enrollment.sequenceId}`);
}

function buildVariableContext(
  enrollment: {
    lead: {
      departureAirport: { city: string; iata: string } | null;
      arrivalAirport: { city: string; iata: string } | null;
      departureDate: Date | null;
      returnDate: Date | null;
      tripType: string;
      cabinClass: string;
      contact: { firstName: string; lastName: string; primaryPhone: string | null; primaryEmail: string | null };
      assignedAgent: { fullName: string; email: string; phone: string | null } | null;
    };
  },
  companyName: string
): SequenceVariableContext {
  const { lead } = enrollment;
  const [senderFirstName, ...rest] = (lead.assignedAgent?.fullName ?? "Your Agent").split(" ");
  return {
    contactFirstName: lead.contact.firstName,
    contactLastName: lead.contact.lastName,
    contactPhone: lead.contact.primaryPhone ?? "",
    contactEmail: lead.contact.primaryEmail ?? "",
    departureCity: lead.departureAirport?.city ?? "",
    departureAirport: lead.departureAirport?.iata ?? "",
    arrivalCity: lead.arrivalAirport?.city ?? "",
    arrivalAirport: lead.arrivalAirport?.iata ?? "",
    departureDate: lead.departureDate ? lead.departureDate.toDateString() : "",
    returnDate: lead.returnDate ? lead.returnDate.toDateString() : "",
    tripType: lead.tripType.replace("_", " "),
    cabinClass: lead.cabinClass.replace("_", " "),
    senderFirstName,
    senderLastName: rest.join(" "),
    senderPhone: lead.assignedAgent?.phone ?? "",
    senderEmail: lead.assignedAgent?.email ?? "",
    companyName,
  };
}

// Pass 19 §8/§23/§49 — concurrency audit found processDueSequenceSteps had
// NO claiming mechanism at all: it read every ACTIVE, due enrollment via a
// plain findMany, then looped through sending emails and updating rows one
// at a time, with nothing preventing a SECOND concurrent invocation (an
// overlapping cron tick, or a manual "Process Due Steps" click while a
// scheduled run is still in flight — both real, ordinary occurrences, not
// exotic edge cases) from reading and processing the exact same set of
// "due" enrollments before the first invocation's per-row updates land,
// sending the same step's email twice to the same recipient. Fixed with a
// lease-style atomic claim, the same conditional-updateMany-as-advisory-
// lock pattern this codebase already uses for sendMarketingCampaign's
// DRAFT->SENDING claim (marketing-campaigns.ts) — no schema change, no new
// enum/status value: nextSendAt (the exact field the "due" query already
// filters on) is pushed CLAIM_LEASE_MS into the future FIRST, via a
// conditional update whose WHERE clause repeats the precise nextSendAt
// value this invocation originally read. If a concurrent invocation
// already claimed (and thus changed) that same row's nextSendAt between
// the read and this claim attempt, the WHERE no longer matches, count is
// 0, and this invocation skips the row entirely rather than double-
// processing it. If a worker crashes mid-send after claiming but before
// its own final update, the lease simply expires after CLAIM_LEASE_MS and
// the row becomes "due" again for a later run — self-healing, no stuck
// enrollment, no manual intervention needed.
const CLAIM_LEASE_MS = 2 * 60_000;

/**
 * Processes all sequence steps due to send right now. This is the extension
 * point a real scheduler (Vercel Cron, a queue worker, etc.) should call —
 * see /api/cron/sequences. No such scheduler is deployed in this dev
 * environment, so the Sequences UI also exposes a manual "Process Due Steps"
 * action for testing.
 */
export async function processDueSequenceSteps() {
  const due = await prisma.sequenceEnrollment.findMany({
    where: { status: "ACTIVE", nextSendAt: { lte: new Date() } },
    include: {
      sequence: { include: { steps: { orderBy: { order: "asc" } } } },
      lead: {
        include: {
          contact: true,
          departureAirport: true,
          arrivalAirport: true,
          assignedAgent: true,
        },
      },
    },
    take: 50,
  });

  let sent = 0;
  let failed = 0;

  for (const enrollment of due) {
    // Atomic claim — see CLAIM_LEASE_MS's own comment above for the full
    // reasoning. Must happen before ANY side effect for this enrollment,
    // including the "no more steps -> COMPLETED" branch just below, which
    // is itself a write two concurrent invocations could otherwise race.
    const claim = await prisma.sequenceEnrollment.updateMany({
      where: { id: enrollment.id, status: "ACTIVE", nextSendAt: enrollment.nextSendAt },
      data: { nextSendAt: new Date(Date.now() + CLAIM_LEASE_MS) },
    });
    if (claim.count === 0) continue; // another concurrent invocation already claimed this row

    const step = enrollment.sequence.steps[enrollment.currentStepIdx];
    if (!step) {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "COMPLETED", completedAt: new Date(), nextSendAt: null },
      });
      continue;
    }

    // Part 4 — the address(es) explicitly chosen at enroll time win when
    // set; otherwise fall back to the contact's primary email, matching
    // the pre-existing behavior for every enrollment that never had a
    // choice to make (only ever one email on file, or bulk-enrolled).
    const toEmail = enrollment.recipientEmail ?? enrollment.lead.contact.primaryEmail;

    // Pass 29 — these two conditions (no email on file, no assigned agent)
    // are not transient: nothing about the passage of time fixes either
    // one on its own, only a human editing the Contact/Lead. Previously
    // this only logged a per-step FAILED SequenceStepLog and `continue`d —
    // the claim above had already pushed nextSendAt CLAIM_LEASE_MS into
    // the future, but nothing advanced currentStepIdx or set a terminal
    // enrollment status, so the SAME enrollment became "due" again ~2
    // minutes later, forever, silently generating a fresh duplicate
    // SequenceStepLog + EmailLog row every cycle with zero visibility to
    // any human that it was permanently stuck. Now transitions the
    // ENROLLMENT itself to the pre-existing (previously unused)
    // EnrollmentStatus.FAILED — the exact same shape the "no more steps"
    // branch below already uses for COMPLETED — so it stops being "due"
    // and shows up as a real, visible terminal state in the CRM instead of
    // retrying invisibly forever. Once the underlying data is fixed (an
    // email added to the contact, an agent assigned to the lead), staff
    // can simply re-run "Apply Sequence" for that lead — enrollLeads's own
    // dedup check only excludes an existing ACTIVE enrollment, so a FAILED
    // one never blocks a fresh attempt.
    if (!toEmail) {
      await prisma.sequenceStepLog.create({
        data: { enrollmentId: enrollment.id, stepId: step.id, status: "FAILED", error: "Contact has no email address" },
      });
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "FAILED", nextSendAt: null },
      });
      failed++;
      continue;
    }

    const agent = enrollment.lead.assignedAgent;
    if (!agent) {
      await prisma.sequenceStepLog.create({
        data: { enrollmentId: enrollment.id, stepId: step.id, status: "FAILED", error: "Lead has no assigned agent to send from" },
      });
      await prisma.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "FAILED", nextSendAt: null },
      });
      failed++;
      continue;
    }

    const company = await getCompanyForAccountId(agent.id);
    const context = buildVariableContext(enrollment, company.name);
    const renderedSubject = renderSequenceTemplate(step.subject, context);
    const renderedBody = renderSequenceTemplate(step.body, context);
    const { subject, html } = buildSequenceEmail({
      subject: renderedSubject,
      bodyText: renderedBody,
      agent: { fullName: agent.fullName, email: agent.email, phone: agent.phone },
      company,
      // Pass 16 §4/§5 — only the automated drip send carries an unsubscribe
      // link; the token is this enrollment's own opaque id (see
      // /api/public/sequence-unsubscribe's own doc comment for why no new
      // schema field was needed).
      unsubscribeUrl: `${resolveBaseUrl()}/api/public/sequence-unsubscribe?enrollment=${enrollment.id}`,
    });
    const result = await sendEmail({
      accountId: agent.id,
      to: toEmail,
      subject,
      html,
      senderName: agent.fullName,
      replyTo: agent.email,
    });

    await prisma.sequenceStepLog.create({
      data: {
        enrollmentId: enrollment.id,
        stepId: step.id,
        status: result.ok ? "SENT" : "FAILED",
        sentAt: result.ok ? new Date() : undefined,
        error: result.ok ? undefined : result.error,
      },
    });
    await prisma.emailLog.create({
      data: {
        type: "SEQUENCE",
        subject,
        fromEmail: agent.email,
        toEmail,
        status: result.ok ? "SENT" : "FAILED",
        errorMessage: result.ok ? undefined : result.error,
        messageId: result.ok ? result.messageId : undefined,
        leadId: enrollment.leadId,
        contactId: enrollment.lead.contactId,
      },
    });

    if (result.ok) sent++;
    else failed++;

    const nextIdx = enrollment.currentStepIdx + 1;
    const nextStep = enrollment.sequence.steps[nextIdx];
    await prisma.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: nextStep
        ? { currentStepIdx: nextIdx, nextSendAt: new Date(Date.now() + nextStep.delayMinutes * 60_000) }
        : { status: "COMPLETED", completedAt: new Date(), nextSendAt: null, currentStepIdx: nextIdx },
    });
  }

  revalidatePath("/sequences");
  return { processed: due.length, sent, failed };
}
