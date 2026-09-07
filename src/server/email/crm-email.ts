// Shared core for "send a one-off, agent-authored email through the CRM,
// on behalf of a Lead or a Contact" — extracted from leads.ts's
// sendLeadEmail (Part 2's original Lead-only implementation) so a new
// Contact-facing composer (Pass 6) can send through the exact same Gmail
// connection, template rendering, EmailLog, and Activity logging, without
// a second parallel implementation.
//
// Security fix folded into this extraction (Pass 6 audit): the original
// sendLeadEmail only validated that `to` was SYNTACTICALLY a valid email
// address (or comma-separated list) — it never checked that the address
// actually belonged to the lead's contact. A caller who bypassed the UI
// (or a compromised/malicious client) could have supplied ANY address —
// `to: "attacker@evil.com"` — and the server would have sent from the
// agent's own connected Gmail to that arbitrary address. This module's
// `allowedRecipients` parameter is mandatory and is always computed
// server-side from the ACTUAL resolved Lead/Contact record, never trusted
// from the client — every recipient in `to` must be a case-insensitive
// match against a real email already on file for that specific
// lead/contact, or the whole send is rejected before anything happens.
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/server/email/service";
import { buildSequenceEmail } from "@/server/email/templates";
import { getCompanyForAccountId } from "@/server/queries/company";
import { getGmailConnectionState } from "@/server/queries/gmail-connection";
import { logActivity } from "@/server/activity-log";

export type CrmEmailActor = { id: string; fullName: string; email: string; phone: string | null };

export class RecipientNotAllowedError extends Error {
  constructor(public readonly rejected: string[]) {
    super(
      rejected.length === 1
        ? `"${rejected[0]}" is not one of this contact's known email addresses.`
        : `These addresses are not known email addresses for this contact: ${rejected.join(", ")}`
    );
    this.name = "RecipientNotAllowedError";
  }
}

/**
 * Sends `to`/`subject`/`body` through `actor`'s own connected Gmail,
 * exactly as sendLeadEmail always has (same template, same EmailLog, same
 * Activity entry) — but only after confirming every recipient address is
 * one of `allowedRecipients` (the real, server-resolved set of email
 * addresses for the lead/contact in question). Throws
 * RecipientNotAllowedError before any Gmail call is made if not — a
 * rejected send never reaches the sending API at all, let alone gets
 * logged as sent.
 */
export async function sendCrmEmail(params: {
  actor: CrmEmailActor;
  to: string;
  subject: string;
  body: string;
  allowedRecipients: Set<string>;
  leadId?: string;
  contactId?: string;
  emailLogType: "LEAD_EMAIL" | "CONTACT_EMAIL";
}): Promise<{ ok: true }> {
  const { actor, to, subject, body, allowedRecipients, leadId, contactId, emailLogType } = params;

  const recipients = to.split(",").map((a) => a.trim()).filter(Boolean);
  const normalizedAllowed = new Set([...allowedRecipients].map((a) => a.trim().toLowerCase()));
  const rejected = recipients.filter((r) => !normalizedAllowed.has(r.toLowerCase()));
  if (rejected.length > 0) {
    throw new RecipientNotAllowedError(rejected);
  }

  const gmailStatus = await getGmailConnectionState(actor.id);
  if (gmailStatus === "REVOKED") {
    throw new Error("Your Gmail connection needs to be reconnected before you can send email. Go to your account menu to reconnect.");
  }
  if (gmailStatus !== "CONNECTED") {
    throw new Error("Connect your Gmail account before sending email. Go to your account menu to connect Gmail.");
  }

  const company = await getCompanyForAccountId(actor.id);
  const { subject: renderedSubject, html } = buildSequenceEmail({
    subject,
    bodyText: body,
    agent: { fullName: actor.fullName, email: actor.email, phone: actor.phone },
    company,
  });

  const result = await sendEmail({
    accountId: actor.id,
    to,
    subject: renderedSubject,
    html,
    senderName: actor.fullName,
    replyTo: actor.email,
  });

  await prisma.emailLog.create({
    data: {
      type: emailLogType,
      subject: renderedSubject,
      fromEmail: actor.email,
      toEmail: to,
      status: result.ok ? "SENT" : "FAILED",
      errorMessage: result.ok ? undefined : result.error,
      messageId: result.ok ? result.messageId : undefined,
      leadId,
      contactId,
    },
  });

  if (!result.ok) {
    throw new Error(result.error || "Failed to send email");
  }

  await logActivity({
    leadId,
    contactId,
    actorId: actor.id,
    type: "EMAIL_SENT",
    description: `Email sent: "${subject}"`,
  });

  return { ok: true };
}
