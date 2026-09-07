import { OAuth2Client } from "google-auth-library";
import MailComposer from "nodemailer/lib/mail-composer";
import { prisma } from "@/lib/prisma";
import { getGoogleClientId, getGoogleClientSecret } from "@/server/auth/google-config";
import { decryptRefreshToken } from "@/server/security/gmail-token-encryption";

// Sends email via the Gmail API (users.messages.send), authenticated as
// whichever CRM Account owns the GmailConnection — never a shared/global
// mailbox. Replaces the old SMTP transport entirely: there is no fallback
// "service account" here at all, by design (see the "Connect Gmail" task).

export type GmailSendInput = {
  /** The CRM Account whose connected Gmail account sends this — required,
   * never optional; there is no longer a global fallback sender. */
  accountId: string;
  to: string;
  /** Additional recipients hidden from the `to` recipient — e.g. internal
   * staff notified of a customer-facing send without being exposed to the
   * customer. Never included in the visible headers the recipient sees. */
  bcc?: string;
  subject: string;
  html: string;
  text?: string;
  /** Display name shown before the sender's own Gmail address (e.g. the
   * agent's full name) — the address itself is always their connected
   * Gmail account, never overridable. */
  senderName?: string;
  replyTo?: string;
};

export type GmailSendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string; code: "NOT_CONNECTED" | "REAUTH_REQUIRED" | "SEND_FAILED" };

const NOT_CONNECTED_MESSAGE = "Gmail is not connected. Connect Gmail to send emails from your account.";
const REAUTH_MESSAGE = "Your Gmail authorization has expired or been revoked. Please reconnect Gmail.";

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function buildRawMessage(input: {
  from: string;
  to: string;
  bcc?: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}): Promise<string> {
  const composer = new MailComposer({
    from: input.from,
    to: input.to,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
  });
  const buffer = await composer.compile().build();
  return toBase64Url(buffer);
}

/** Google's shape for "this refresh token no longer works" — the user
 * revoked access from their Google account, or Google invalidated it. */
function isInvalidGrantError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /invalid_grant/i.test(message);
}

async function markRevoked(accountId: string) {
  await prisma.gmailConnection.update({
    where: { accountId },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
}

/** Classifies a non-2xx Gmail API response into the right user-facing
 * outcome without exposing raw API/error details to the caller. */
function classifyGmailApiFailure(status: number, body: unknown): { code: "REAUTH_REQUIRED" | "SEND_FAILED"; error: string } {
  if (status === 401) {
    return { code: "REAUTH_REQUIRED", error: REAUTH_MESSAGE };
  }
  const reason =
    body && typeof body === "object" && "error" in body
      ? ((body as { error?: { errors?: Array<{ reason?: string }>; status?: string } }).error?.errors?.[0]?.reason ??
        (body as { error?: { status?: string } }).error?.status)
      : undefined;
  if (status === 403 && (reason === "insufficientPermissions" || reason === "PERMISSION_DENIED")) {
    return { code: "REAUTH_REQUIRED", error: REAUTH_MESSAGE };
  }
  if (status === 429 || reason === "rateLimitExceeded" || reason === "quotaExceeded" || reason === "userRateLimitExceeded") {
    return { code: "SEND_FAILED", error: "Gmail is temporarily unable to send (rate limit reached). Please try again shortly." };
  }
  return { code: "SEND_FAILED", error: "Gmail could not send this email. Please try again." };
}

export async function sendViaGmail(input: GmailSendInput): Promise<GmailSendResult> {
  const connection = await prisma.gmailConnection.findUnique({ where: { accountId: input.accountId } });
  if (!connection) {
    return { ok: false, code: "NOT_CONNECTED", error: NOT_CONNECTED_MESSAGE };
  }
  if (connection.status === "REVOKED") {
    return { ok: false, code: "REAUTH_REQUIRED", error: REAUTH_MESSAGE };
  }

  const client = new OAuth2Client(getGoogleClientId(), getGoogleClientSecret());
  client.setCredentials({ refresh_token: decryptRefreshToken(connection.encryptedRefreshToken) });

  let accessToken: string;
  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("no access token returned");
    accessToken = token;
  } catch (err) {
    if (isInvalidGrantError(err)) {
      await markRevoked(input.accountId);
      return { ok: false, code: "REAUTH_REQUIRED", error: REAUTH_MESSAGE };
    }
    // Deliberately never logs `err` itself — an OAuth-library error object
    // can embed request/response details that touch token material.
    console.error("[gmail-send] access token refresh failed");
    return { ok: false, code: "SEND_FAILED", error: "Could not connect to Gmail. Please try again." };
  }

  const raw = await buildRawMessage({
    from: `${input.senderName ?? connection.googleEmail} <${connection.googleEmail}>`,
    to: input.to,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
  });

  try {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const { code, error } = classifyGmailApiFailure(response.status, body);
      if (code === "REAUTH_REQUIRED") await markRevoked(input.accountId);
      return { ok: false, code, error };
    }

    const data = (await response.json()) as { id: string };
    return { ok: true, messageId: data.id };
  } catch {
    console.error("[gmail-send] request to Gmail API failed");
    return { ok: false, code: "SEND_FAILED", error: "Could not reach Gmail. Please try again." };
  }
}
