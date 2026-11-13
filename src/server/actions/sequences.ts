"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { classifyLeadsForEnrollment } from "@/server/sequence-enrollment-eligibility";
import { logActivity } from "@/server/activity-log";
import { canManageSequences, canManageAllSequences, canViewSequencesPage } from "@/lib/permissions";
import { runDueSequenceSteps } from "@/server/due-sequence-steps";
import { sequenceVisibilityWhere } from "@/server/visibility";

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
  noAssignedAgent: number;
  gmailUnavailable: number;
  inaccessible: number;
  /** What happened to EVERY lead id that was asked about (after de-duplication), so callers never have to infer it from counts. */
  byLead: Record<string, "enrolled" | "alreadyActive" | "missingEmail" | "noAssignedAgent" | "gmailUnavailable" | "inaccessible">;
  error?: string;
  /** Set when at least one lead was refused because the account that sends its emails has no usable Gmail. */
  gmailProblem?: "NOT_CONNECTED" | "REAUTH_REQUIRED";
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
export async function enrollLeads(sequenceId: string, leadIds: string[], recipientEmail?: string): Promise<EnrollLeadsResult> {
  const actor = await getCurrentAccount();
  await assertSequenceAccess(actor, sequenceId);

  const sequence = await prisma.sequence.findUniqueOrThrow({
    where: { id: sequenceId },
    include: { steps: { orderBy: { order: "asc" }, take: 1 } },
  });
  const firstStep = sequence.steps[0];
  // The sequence pickers only offer active sequences, but this is a public server action: refuse here too, before any Gmail or lead lookups.
  if (!sequence.isActive) {
    return {
      enrolled: 0, skipped: 0, alreadyActive: 0, missingEmail: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0, byLead: {},
      error: "This sequence is inactive. Switch it to Active before enrolling leads.",
    };
  }

  const c = await classifyLeadsForEnrollment({ actor, sequenceId, leadIds, recipientEmail, verifyGmail: true });
  const count = (v: string) => [...c.verdicts.values()].filter((x) => x === v).length;
  const result: EnrollLeadsResult = {
    enrolled: 0,
    skipped: 0,
    alreadyActive: count("alreadyActive"),
    missingEmail: count("missingEmail"),
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
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${sequenceId}:${leadId}`}, 0))`;
        }
        const taken = new Set(
          (await tx.sequenceEnrollment.findMany({ where: { sequenceId, leadId: { in: chunk }, status: "ACTIVE" }, select: { leadId: true } })).map((en) => en.leadId)
        );
        const fresh = chunk.filter((id) => !taken.has(id));
        if (fresh.length > 0) {
          await tx.sequenceEnrollment.createMany({
            data: fresh.map((leadId) => ({
              sequenceId,
              leadId,
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

/**
 * Stops an ACTIVE enrollment: it becomes UNSUBSCRIBED and nextSendAt is cleared, so the sequence worker no longer sees it as due; the
 * worker also re-confirms ACTIVE atomically right before each send (see processDueSequenceSteps), so a job already in flight cannot
 * send after this commits. Emails already sent stay in the history. Only an ACTIVE enrollment can be unenrolled - a COMPLETED / FAILED /
 * UNSUBSCRIBED one is left exactly as it is. When `leadId` is given (the lead profile), the enrollment must belong to that lead.
 * Authorization is the existing sequence rule (assertSequenceAccess); the audit entry is written to the lead's Activity history.
 */
export async function unenrollLead(enrollmentId: string, leadId?: string): Promise<{ ok: boolean; error?: string }> {
  const actor = await getCurrentAccount();
  const existing = await prisma.sequenceEnrollment.findUnique({
    where: { id: enrollmentId },
    select: { id: true, sequenceId: true, leadId: true, sequence: { select: { name: true } } },
  });
  if (!existing) throw new Error(SEQUENCE_NOT_FOUND);
  const sequence = await assertSequenceAccess(actor, existing.sequenceId);
  // Same generic answer as a missing enrollment: a caller learns nothing about enrollments that are not theirs to touch.
  if (leadId !== undefined && existing.leadId !== leadId) throw new Error(SEQUENCE_NOT_FOUND);

  const stopped = await prisma.sequenceEnrollment.updateMany({
    where: { id: enrollmentId, status: "ACTIVE" },
    data: { status: "UNSUBSCRIBED", nextSendAt: null },
  });
  if (stopped.count === 0) return { ok: false, error: "This enrollment is no longer active." };

  await logActivity({
    leadId: existing.leadId,
    actorId: actor?.id,
    type: "SEQUENCE_UNENROLLED",
    description: `Removed from sequence "${existing.sequence?.name ?? sequence.name}"`,
  });
  revalidatePath(`/sequences/${existing.sequenceId}`);
  revalidatePath(`/leads/${existing.leadId}`);
  return { ok: true };
}

/**
 * The signed-in "Process Due Steps" button. The sweep itself (runDueSequenceSteps, src/server/due-sequence-steps.ts) is not a Server Action, so the cron
 * route can call it without a user; this wrapper is the public action and carries its own role check instead of trusting the page that shows the button.
 */
export async function processDueSequenceSteps() {
  const actor = await getCurrentAccount();
  if (!actor || !canViewSequencesPage(actor.role)) throw new Error("You are not authorized to process due sequence steps");
  return runDueSequenceSteps();
}
