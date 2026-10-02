import { sendEmail, type SendEmailResult } from "@/server/email/service";
import { getGmailConnectionState } from "@/server/queries/gmail-connection";

// Sends an internal notification FROM a CRM user's own connected Gmail TO that
// same user's own address — the "self-addressed notification" pattern the
// reassignment emails use. The sender is always the recipient themselves:
// Gmail only ever authenticates as the account that connected it, so there is
// no way (and no attempt) to send "as" anyone else, and nobody else's
// connection — in particular the admin/manager who performed the action — is
// ever substituted. When the user has not connected Gmail (or the connection
// no longer works) the send is reported as failed so the caller can record
// it; it is never rerouted through another person's mailbox.

export type OwnGmailRecipient = { id: string; email: string; fullName: string };

export type OwnGmailSendOutcome = {
  result: SendEmailResult;
  /** The address the email actually went out from, or "unsent" when it did not. */
  fromEmail: string;
};

const NOT_CONNECTED: SendEmailResult = { ok: false, error: "This user has not connected Gmail, so the notification could not be sent from their own account." };

export async function sendFromOwnGmail(params: { owner: OwnGmailRecipient; subject: string; html: string }): Promise<OwnGmailSendOutcome> {
  const { owner, subject, html } = params;
  if ((await getGmailConnectionState(owner.id)) !== "CONNECTED") {
    return { result: NOT_CONNECTED, fromEmail: "unsent" };
  }
  const result = await sendEmail({ accountId: owner.id, to: owner.email, subject, html, senderName: owner.fullName });
  return { result, fromEmail: result.ok ? owner.email : "unsent" };
}
