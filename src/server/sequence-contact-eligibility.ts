import { prisma } from "@/lib/prisma";
import { contactVisibilityWhere, type Viewer } from "@/server/visibility";
import { checkGmailSendReadiness, type GmailReadiness } from "@/server/email/gmail-send";
import { chooseRecipients, candidateAddresses, doNotEmail, recipientToStore, type RecipientMode } from "@/server/sequence-recipients";
import { GMAIL_VERIFY_LIMIT, describeGmailProblem, type GmailProblemCode, type SendingAgent } from "@/server/sequence-enrollment-eligibility";
import { senderForNewContactEnrollment } from "@/server/sequence-sender";

// The ONE place that decides whether a CONTACT can be enrolled in a sequence WITHOUT a lead (the counterpart of classifyLeadsForEnrollment in
// sequence-enrollment-eligibility.ts, which is unchanged). It reuses the same pieces: the same row-level visibility (contactVisibilityWhere), the same recipient rules
// (primary or all addresses, validated, de-duplicated, do-not-email applied: sequence-recipients.ts), the same real Gmail readiness check of the account that will send.
//
// Deliberately NOT a "use server" module: its exports are not server actions.
//
// A contact is eligible when: the caller can see it (company and ownership); no ACTIVE enrollment of EITHER kind exists for it in this sequence (so the same person is never in the
// same sequence twice at once, through a lead or without); it has at least one VALID address that is not on the company's do-not-email list; and the account that will send
// (the contact's owner, else the person enrolling) belongs to the caller's company and has a usable Gmail. A lead is NEVER required, created or changed.

export type ContactVerdict = "eligible" | "alreadyActive" | "missingEmail" | "addressSuppressed" | "gmailUnavailable" | "inaccessible";

export type ContactClassification = {
  /** One verdict for every distinct contact id that was asked about. */
  verdicts: Map<string, ContactVerdict>;
  /** What the enrollment stores as its recipient (undefined = "the contact's primary at send time", as for every primary-only enrollment). */
  recipientByContact: Map<string, string | undefined>;
  /** The account that will send each eligible contact's emails. */
  senderByContact: Map<string, SendingAgent>;
  blocked: Array<{ contactId: string; agent: SendingAgent; code: GmailProblemCode }>;
  gmailProblem?: GmailProblemCode;
  gmailMessage?: string;
  gmailSender?: SendingAgent;
};

export async function classifyContactsForEnrollment(params: {
  actor: NonNullable<Viewer> & { fullName: string };
  sequenceId: string;
  contactIds: string[];
  recipientMode?: RecipientMode;
  /** true: also ask Google's token endpoint for up to GMAIL_VERIFY_LIMIT distinct senders (no mail is sent). false: local checks only. */
  verifyGmail: boolean;
}): Promise<ContactClassification> {
  const { actor, sequenceId } = params;
  const requestedIds = [...new Set(params.contactIds)];
  const verdicts = new Map<string, ContactVerdict>();
  const recipientByContact = new Map<string, string | undefined>();
  const senderByContact = new Map<string, SendingAgent>();
  const blocked: ContactClassification["blocked"] = [];
  const empty = { verdicts, recipientByContact, senderByContact, blocked };
  if (requestedIds.length === 0) return empty;

  // Only a contact the caller can actually see can be enrolled: a client-supplied id list is never trusted.
  const details = await prisma.contact.findMany({
    where: { id: { in: requestedIds }, ...contactVisibilityWhere(actor) },
    select: { id: true, companyId: true, primaryEmail: true, emails: { select: { email: true } }, owner: { select: { id: true, fullName: true, companyId: true } } },
  });
  const visible = new Set(details.map((d) => d.id));
  for (const id of requestedIds) if (!visible.has(id)) verdicts.set(id, "inaccessible");
  if (details.length === 0) return empty;

  // ANY active enrollment of this contact in this sequence blocks a new one (through one of its leads, or contact-only). Deliberately not limited to leads the caller can see:
  // "already enrolled" reveals nothing beyond what seeing the contact already shows, and it is what stops the same person receiving the same sequence twice.
  const active = new Set(
    (await prisma.sequenceEnrollment.findMany({ where: { sequenceId, status: "ACTIVE", contactId: { in: [...visible] } }, select: { contactId: true } })).map((e) => e.contactId)
  );

  const mode: RecipientMode = params.recipientMode ?? "primary";
  const inPlay = new Map<string, Set<string>>();
  for (const c of details) {
    const set = inPlay.get(c.companyId) ?? new Set<string>();
    for (const a of candidateAddresses(c, "all")) set.add(a);
    inPlay.set(c.companyId, set);
  }
  const blockedByCompany = new Map<string, Set<string>>();
  for (const [companyId, addresses] of inPlay) blockedByCompany.set(companyId, await doNotEmail(companyId, [...addresses]));

  const actorSender: SendingAgent & { companyId: string } = { id: actor.id, fullName: actor.fullName, companyId: actor.companyId };
  const candidates: Array<{ id: string; agent: SendingAgent }> = [];
  for (const c of details) {
    if (active.has(c.id)) {
      verdicts.set(c.id, "alreadyActive");
      continue;
    }
    const choice = chooseRecipients(c, mode, blockedByCompany.get(c.companyId) ?? new Set<string>());
    if (!choice.ok) {
      verdicts.set(c.id, choice.reason);
      continue;
    }
    // The emails go out from the contact's owner, else from the person enrolling. That account must belong to the SAME company as the person enrolling: one company can
    // never send through another company's Gmail connection, whatever the data says.
    const sender = senderForNewContactEnrollment(c.owner, actorSender);
    if (!sender || sender.companyId !== actor.companyId) {
      verdicts.set(c.id, "inaccessible");
      continue;
    }
    recipientByContact.set(c.id, recipientToStore(mode, choice.addresses, c.primaryEmail));
    senderByContact.set(c.id, { id: sender.id, fullName: sender.fullName });
    candidates.push({ id: c.id, agent: { id: sender.id, fullName: sender.fullName } });
  }

  // Can the account that will send these emails actually send? Checked once per distinct sender, without sending anything.
  const readiness = new Map<string, GmailReadiness>();
  let verifyBudget = params.verifyGmail ? GMAIL_VERIFY_LIMIT : 0;
  for (const agent of new Map(candidates.map((x) => [x.agent.id, x.agent])).values()) {
    readiness.set(agent.id, await checkGmailSendReadiness(agent.id, { verifyToken: verifyBudget-- > 0 }));
  }
  for (const x of candidates) {
    const r = readiness.get(x.agent.id);
    if (!r || r.ready) verdicts.set(x.id, "eligible");
    else {
      verdicts.set(x.id, "gmailUnavailable");
      blocked.push({ contactId: x.id, agent: x.agent, code: r.code });
    }
  }
  const out: ContactClassification = { ...empty };
  if (blocked.length > 0) {
    out.gmailProblem = blocked[0].code;
    out.gmailSender = blocked[0].agent;
    out.gmailMessage = describeGmailProblem(blocked[0].code, blocked[0].agent, actor.id, "contact");
  }
  return out;
}
