import { prisma } from "@/lib/prisma";
import { leadVisibilityWhere, type Viewer } from "@/server/visibility";
import { checkGmailSendReadiness, type GmailReadiness, type GmailReadinessFailure } from "@/server/email/gmail-send";
import { candidateAddresses, chooseRecipients, doNotEmail, isValidAddress, recipientToStore, type RecipientMode } from "@/server/sequence-recipients";

// The ONE place that decides whether a lead can be enrolled in a sequence. enrollLeads (the enrollment itself), bulkEnrollInSequence (through
// enrollLeads) and the Sequences section's status-based preview/enrollment all call classifyLeadsForEnrollment, so the counts a person is shown
// before confirming are produced by exactly the rules that then run. Deliberately NOT a "use server" module: its exports are not server actions
// and cannot be called from the browser.
//
// A lead is eligible only when emails can actually be sent for it: the caller can see it, nothing ACTIVE already exists for it in this sequence
// (a FAILED / UNSUBSCRIBED / COMPLETED / REPLIED enrollment never blocks), it has a VALID address to send to that is not on the do-not-email list (an unsubscribed or
// suppressed marketing subscriber), it has an assigned agent (the account the sequence emails are sent from) and that agent's Gmail is usable. Which of the contact's
// addresses are used is the recipient mode: "primary" (default) or "all" (see server/sequence-recipients.ts).

export type LeadVerdict = "eligible" | "alreadyActive" | "missingEmail" | "addressSuppressed" | "noAssignedAgent" | "gmailUnavailable" | "inaccessible";
export type GmailProblemCode = GmailReadinessFailure;

/** True when the user must (re)connect Gmail to fix it; false for a temporary problem where "connect Gmail" would be the wrong advice. */
export function gmailProblemNeedsReconnect(code: GmailProblemCode): boolean {
  return code !== "TEMPORARILY_UNAVAILABLE";
}
export type SendingAgent = { id: string; fullName: string };

/** Distinct sending accounts whose refresh token is checked against Google in ONE classification; the rest get the local-only check. */
export const GMAIL_VERIFY_LIMIT = 25;

export function describeGmailProblem(code: GmailProblemCode, agent: SendingAgent, actorId: string | undefined, subject: "lead" | "contact" = "lead"): string {
  const mine = agent.id === actorId;
  const who = mine ? "Your Gmail" : `${agent.fullName}'s Gmail`;
  const how = mine ? "Use the account menu (top right) > Connect Gmail, then try again." : `Ask ${agent.fullName} to connect Gmail from their account menu, then try again.`;
  const nothing = `No emails have been sent and this ${subject} has not been enrolled.`;
  switch (code) {
    case "NOT_CONNECTED":
      return `Gmail is not connected. ${who} is not connected, and it is the account that sends this ${subject}'s sequence emails. ${nothing} ${how}`;
    case "REAUTH_REQUIRED":
      return `Gmail needs to be reconnected. ${who} authorization has expired or been revoked. ${nothing} ${how}`;
    case "MISSING_PERMISSION":
      return `Gmail cannot send email. ${who} is connected, but the permission to send email was not granted. ${nothing} ${mine ? "Reconnect Gmail from the account menu and allow sending, then try again." : `Ask ${agent.fullName} to reconnect Gmail and allow sending, then try again.`}`;
    case "TEMPORARILY_UNAVAILABLE":
    default:
      // Not a connection problem: do NOT tell the user to connect Gmail.
      return `Gmail could not be checked right now. ${who} may be connected, but Google did not answer. ${nothing} Nothing needs to be reconnected - try again in a moment.`;
  }
}

export type EnrollmentClassification = {
  /** One verdict for every distinct lead id that was asked about. */
  verdicts: Map<string, LeadVerdict>;
  /** Explicit recipient address(es) validated against the lead's own contact emails (only when one was requested and valid). */
  recipientByLead: Map<string, string>;
  /** The contact each ELIGIBLE lead belongs to (an enrollment always records its contact as well as its lead). */
  contactByLead: Map<string, string>;
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
  /** Which of each contact's addresses the emails go to when no explicit recipient was chosen: "primary" (default) or "all". */
  recipientMode?: RecipientMode;
  /** true: also ask Google's token endpoint for up to GMAIL_VERIFY_LIMIT distinct agents (no mail is sent). false: local checks only. */
  verifyGmail: boolean;
}): Promise<EnrollmentClassification> {
  const { actor, sequenceId } = params;
  const requestedIds = [...new Set(params.leadIds)];
  const verdicts = new Map<string, LeadVerdict>();
  const recipientByLead = new Map<string, string>();
  const contactByLead = new Map<string, string>();
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
  if (ids.length === 0) return { verdicts, recipientByLead, contactByLead, blocked };

  // Only a genuinely ACTIVE enrollment blocks a new one.
  const active = new Set(
    (await prisma.sequenceEnrollment.findMany({ where: { sequenceId, leadId: { in: ids }, status: "ACTIVE" }, select: { leadId: true } })).map((e) => e.leadId)
  );
  const toCheck: string[] = [];
  for (const id of ids) {
    if (active.has(id)) verdicts.set(id, "alreadyActive");
    else toCheck.push(id);
  }
  // Duplicate policy (documented in docs/SEQUENCES.md): a person is never in the same sequence twice at once through the two kinds of enrollment. A lead whose CONTACT already has
  // an ACTIVE contact-only enrollment in this sequence is "already enrolled" (lead-vs-lead is unchanged: it is still decided per lead).
  const contactOnlyActive = toCheck.length
    ? new Set(
        (
          await prisma.sequenceEnrollment.findMany({
            where: { sequenceId, leadId: null, status: "ACTIVE", contact: { leads: { some: { id: { in: toCheck } } } } },
            select: { contactId: true },
          })
        ).map((e) => e.contactId)
      )
    : new Set<string>();

  const details =
    toCheck.length > 0
      ? await prisma.lead.findMany({
          where: { id: { in: toCheck } },
          select: {
            id: true,
            contactId: true,
            contact: { select: { companyId: true, primaryEmail: true, emails: { select: { email: true } } } },
            assignedAgent: { select: { id: true, fullName: true, companyId: true } },
          },
        })
      : [];

  const requested = params.recipientEmail ? params.recipientEmail.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean) : [];
  const mode: RecipientMode = params.recipientMode ?? "primary";
  // One read: which of the addresses in play are on a company's do-not-email list (unsubscribed / suppressed subscribers).
  const inPlay = new Map<string, Set<string>>();
  for (const lead of details) {
    const set = inPlay.get(lead.contact.companyId) ?? new Set<string>();
    for (const a of candidateAddresses(lead.contact, "all")) set.add(a);
    for (const a of requested) set.add(a);
    inPlay.set(lead.contact.companyId, set);
  }
  const blockedByCompany = new Map<string, Set<string>>();
  for (const [companyId, addresses] of inPlay) blockedByCompany.set(companyId, await doNotEmail(companyId, [...addresses]));

  const candidates: Array<{ id: string; agent: SendingAgent }> = [];
  for (const lead of details) {
    if (contactOnlyActive.has(lead.contactId)) {
      verdicts.set(lead.id, "alreadyActive");
      continue;
    }
    const known = new Set(
      [lead.contact.primaryEmail, ...lead.contact.emails.map((em) => em.email)].filter((a): a is string => !!a).map((a) => a.toLowerCase())
    );
    const blocked = blockedByCompany.get(lead.contact.companyId) ?? new Set<string>();
    const explicit = requested.filter((r) => known.has(r) && isValidAddress(r));
    // The address(es) the automated sends will actually go to: the validated explicit choice, else what the recipient mode says (primary at send time, or every valid
    // address on file). Invalid, duplicate and do-not-email addresses never make it into the list.
    let toStore: string | undefined;
    if (explicit.length > 0) {
      const usable = explicit.filter((a) => !blocked.has(a));
      if (usable.length === 0) {
        verdicts.set(lead.id, "addressSuppressed");
        continue;
      }
      toStore = usable.join(", ");
    } else {
      const choice = chooseRecipients(lead.contact, mode, blocked);
      if (!choice.ok) {
        verdicts.set(lead.id, choice.reason);
        continue;
      }
      toStore = recipientToStore(mode, choice.addresses, lead.contact.primaryEmail);
    }
    if (!lead.assignedAgent) {
      verdicts.set(lead.id, "noAssignedAgent"); // no sender to send from: the worker would only fail this enrollment on its first run
      continue;
    }
    // The emails are sent from the assigned agent's own Gmail. That account must belong to the SAME company as the person enrolling: one company can never
    // send through another company's Gmail connection, whatever the data says.
    if (actor && lead.assignedAgent.companyId !== actor.companyId) {
      verdicts.set(lead.id, "inaccessible");
      continue;
    }
    if (toStore) recipientByLead.set(lead.id, toStore);
    contactByLead.set(lead.id, lead.contactId);
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
  const out: EnrollmentClassification = { verdicts, recipientByLead, contactByLead, blocked };
  if (blocked.length > 0) {
    out.gmailProblem = blocked[0].code;
    out.gmailMessage = describeGmailProblem(blocked[0].code, blocked[0].agent, actor?.id);
  }
  return out;
}
