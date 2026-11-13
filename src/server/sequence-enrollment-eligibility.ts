import { prisma } from "@/lib/prisma";
import { leadVisibilityWhere, type Viewer } from "@/server/visibility";
import { checkGmailSendReadiness, type GmailReadiness } from "@/server/email/gmail-send";

// The ONE place that decides whether a lead can be enrolled in a sequence. enrollLeads (the enrollment itself), bulkEnrollInSequence (through
// enrollLeads) and the Sequences section's status-based preview/enrollment all call classifyLeadsForEnrollment, so the counts a person is shown
// before confirming are produced by exactly the rules that then run. Deliberately NOT a "use server" module: its exports are not server actions
// and cannot be called from the browser.
//
// A lead is eligible only when emails can actually be sent for it: the caller can see it, nothing ACTIVE already exists for it in this sequence
// (a FAILED / UNSUBSCRIBED / COMPLETED enrollment never blocks), it has an address to send to, it has an assigned agent (the account the
// sequence emails are sent from) and that agent's Gmail is usable.

export type LeadVerdict = "eligible" | "alreadyActive" | "missingEmail" | "noAssignedAgent" | "gmailUnavailable" | "inaccessible";
export type GmailProblemCode = "NOT_CONNECTED" | "REAUTH_REQUIRED";
export type SendingAgent = { id: string; fullName: string };

/** Distinct sending accounts whose refresh token is checked against Google in ONE classification; the rest get the local-only check. */
export const GMAIL_VERIFY_LIMIT = 25;

export function describeGmailProblem(code: GmailProblemCode, agent: SendingAgent, actorId: string | undefined): string {
  const mine = agent.id === actorId;
  const who = mine ? "Your Gmail" : `${agent.fullName}'s Gmail`;
  const how = mine ? "Use the account menu (top right) > Connect Gmail, then try again." : `Ask ${agent.fullName} to connect Gmail from their account menu, then try again.`;
  return code === "NOT_CONNECTED"
    ? `Gmail is not connected. ${who} is not connected, and it is the account that sends this lead's sequence emails. ${how}`
    : `Gmail needs to be reconnected. ${who} authorization has expired or been revoked. ${how}`;
}

export type EnrollmentClassification = {
  /** One verdict for every distinct lead id that was asked about. */
  verdicts: Map<string, LeadVerdict>;
  /** Explicit recipient address(es) validated against the lead's own contact emails (only when one was requested and valid). */
  recipientByLead: Map<string, string>;
  /** Leads refused because their sending agent's Gmail is unavailable, with the agent that would have sent. */
  blocked: Array<{ leadId: string; agent: SendingAgent; code: GmailProblemCode }>;
  gmailProblem?: GmailProblemCode;
  gmailMessage?: string;
};

export async function classifyLeadsForEnrollment(params: {
  actor: Viewer;
  sequenceId: string;
  leadIds: string[];
  /** Comma-separated explicit recipient(s) chosen at enroll time (validated here against each lead's own contact emails). */
  recipientEmail?: string;
  /** true: also ask Google's token endpoint for up to GMAIL_VERIFY_LIMIT distinct agents (no mail is sent). false: local checks only. */
  verifyGmail: boolean;
}): Promise<EnrollmentClassification> {
  const { actor, sequenceId } = params;
  const requestedIds = [...new Set(params.leadIds)];
  const verdicts = new Map<string, LeadVerdict>();
  const recipientByLead = new Map<string, string>();
  const blocked: EnrollmentClassification["blocked"] = [];

  // A lead can only be enrolled by someone who can actually see it - never trust a client-supplied id list blindly.
  const visible = new Set(
    requestedIds.length === 0
      ? []
      : (await prisma.lead.findMany({ where: { id: { in: requestedIds }, ...leadVisibilityWhere(actor) }, select: { id: true } })).map((l) => l.id)
  );
  const ids: string[] = [];
  for (const id of requestedIds) {
    if (visible.has(id)) ids.push(id);
    else verdicts.set(id, "inaccessible");
  }
  if (ids.length === 0) return { verdicts, recipientByLead, blocked };

  // Only a genuinely ACTIVE enrollment blocks a new one.
  const active = new Set(
    (await prisma.sequenceEnrollment.findMany({ where: { sequenceId, leadId: { in: ids }, status: "ACTIVE" }, select: { leadId: true } })).map((e) => e.leadId)
  );
  const toCheck: string[] = [];
  for (const id of ids) {
    if (active.has(id)) verdicts.set(id, "alreadyActive");
    else toCheck.push(id);
  }

  const details =
    toCheck.length > 0
      ? await prisma.lead.findMany({
          where: { id: { in: toCheck } },
          select: {
            id: true,
            contact: { select: { primaryEmail: true, emails: { select: { email: true } } } },
            assignedAgent: { select: { id: true, fullName: true } },
          },
        })
      : [];

  const requested = params.recipientEmail ? params.recipientEmail.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean) : [];
  const candidates: Array<{ id: string; agent: SendingAgent }> = [];
  for (const lead of details) {
    const known = new Set(
      [lead.contact.primaryEmail, ...lead.contact.emails.map((em) => em.email)].filter((a): a is string => !!a).map((a) => a.toLowerCase())
    );
    const validated = requested.filter((r) => known.has(r));
    // The address the automated sends will actually go to: the validated explicit choice, else the contact's primary email at send time.
    if (validated.length === 0 && !lead.contact.primaryEmail) {
      verdicts.set(lead.id, "missingEmail");
      continue;
    }
    if (!lead.assignedAgent) {
      verdicts.set(lead.id, "noAssignedAgent"); // no sender to send from: the worker would only fail this enrollment on its first run
      continue;
    }
    if (validated.length > 0) recipientByLead.set(lead.id, validated.join(", "));
    candidates.push({ id: lead.id, agent: lead.assignedAgent });
  }
  // A lead that vanished between the visibility query and this one is simply not eligible.
  const found = new Set(details.map((d) => d.id));
  for (const id of toCheck) if (!found.has(id)) verdicts.set(id, "inaccessible");

  // Can the account that will send these emails actually send? Checked once per distinct agent, without sending anything.
  const readiness = new Map<string, GmailReadiness>();
  let verifyBudget = params.verifyGmail ? GMAIL_VERIFY_LIMIT : 0;
  for (const agent of new Map(candidates.map((c) => [c.agent.id, c.agent])).values()) {
    readiness.set(agent.id, await checkGmailSendReadiness(agent.id, { verifyToken: verifyBudget-- > 0 }));
  }
  for (const c of candidates) {
    const r = readiness.get(c.agent.id);
    if (!r || r.ready) verdicts.set(c.id, "eligible");
    else {
      verdicts.set(c.id, "gmailUnavailable");
      blocked.push({ leadId: c.id, agent: c.agent, code: r.code });
    }
  }
  const out: EnrollmentClassification = { verdicts, recipientByLead, blocked };
  if (blocked.length > 0) {
    out.gmailProblem = blocked[0].code;
    out.gmailMessage = describeGmailProblem(blocked[0].code, blocked[0].agent, actor?.id);
  }
  return out;
}
