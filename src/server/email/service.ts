import { sendViaGmail } from "@/server/email/gmail-send";

// Email service abstraction — every outbound email in the CRM goes through
// sendEmail(), which sends via the Gmail API as the CRM Account identified
// by `accountId`. There is no shared/global mailbox and no SMTP transport
// of any kind: each send is authenticated as that specific account's own
// connected Gmail (see src/server/actions/gmail-connect.ts for how an
// account connects one, and src/server/email/gmail-send.ts for the actual
// Gmail API call). If that account hasn't connected Gmail, the send fails
// closed with a clear, actionable error — never a fallback sender.

export type SendEmailInput = {
  /** The CRM Account whose connected Gmail account sends this email —
   * required. There is no default/fallback sender. */
  accountId: string;
  to: string;
  /** Additional recipients hidden from the primary `to` recipient — never
   * exposed to them in any visible header. */
  bcc?: string;
  subject: string;
  html: string;
  text?: string;
  /** Display name shown before the sender's own Gmail address (e.g. the
   * agent's full name). Falls back to their connected Gmail address when
   * omitted. */
  senderName?: string;
  replyTo?: string;
};

export type SendEmailResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string; code?: "NOT_CONNECTED" | "REAUTH_REQUIRED" | "SEND_FAILED" };

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  return sendViaGmail(input);
}
