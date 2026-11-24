import { OAuth2Client } from "google-auth-library";
import MailComposer from "nodemailer/lib/mail-composer";
import { prisma } from "@/lib/prisma";
import { getGoogleClientId, getGoogleClientSecret } from "@/server/auth/google-config";
import { decryptRefreshToken } from "@/server/security/gmail-token-encryption";
import { GMAIL_SEND_SCOPE } from "@/server/auth/gmail-oauth-config";
import { DEFAULT_RATE_LIMIT_BACKOFF_MS } from "@/server/sender-quota";

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
  bcc?: string | string[];
  subject: string;
  html: string;
  text?: string;
  /** Display name shown before the sender's own Gmail address (e.g. the
   * agent's full name) — the address itself is always their connected
   * Gmail account, never overridable. */
  senderName?: string;
  replyTo?: string;
  /** Marketing mail only: the absolute https URL of this recipient's unsubscribe endpoint. It becomes the RFC 8058 one-click pair
   * (List-Unsubscribe + List-Unsubscribe-Post) that Gmail and other mailbox providers require from bulk marketing senders. */
  listUnsubscribeUrl?: string;
};

export type GmailSendResult =
  | {
      ok: true;
      messageId: string;
      /** Gmail's conversation id for the sent message: a customer's reply lands in this thread. Absent when Gmail did not return one. */
      threadId?: string;
    }
  | {
      ok: false;
      error: string;
      code: "NOT_CONNECTED" | "REAUTH_REQUIRED" | "SEND_FAILED";
      /** true = Gmail refused because a sending limit was reached (not a broken connection, not a bad message). `retryAfterMs` is Gmail's own advice when it gave one. */
      rateLimited?: boolean;
      retryAfterMs?: number;
      /**
       * true = the request may have REACHED Gmail and been accepted even though no confirmation came back (a timeout, a dropped connection, a 5xx): the
       * message might have been sent. A caller that sends to a customer must NOT blindly resend. Absent/false = Gmail definitely did not send it (no
       * request was made, or Gmail answered with a definite refusal such as 401/403/429/other 4xx).
       */
      ambiguous?: boolean;
    };

/** How long the Gmail send request may take before it is abandoned as an UNKNOWN outcome. */
export const GMAIL_SEND_TIMEOUT_MS = 30_000;

const NOT_CONNECTED_MESSAGE = "Gmail is not connected. Connect Gmail to send emails from your account.";
const REAUTH_MESSAGE = "Your Gmail authorization has expired or been revoked. Please reconnect Gmail.";

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function buildRawMessage(input: {
  from: string;
  to: string;
  bcc?: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  listUnsubscribeUrl?: string;
}): Promise<string> {
  const composer = new MailComposer({
    from: input.from,
    to: input.to,
    bcc: input.bcc,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
    // RFC 8058 one-click unsubscribe. Only an https URL is ever put in a header (a value with angle brackets, spaces or line breaks is refused, so a header can
    // never be injected); anything else sends the message without the pair rather than with a malformed one.
    ...(input.listUnsubscribeUrl && /^https:\/\/[^\s<>"]+$/.test(input.listUnsubscribeUrl)
      ? { headers: { "List-Unsubscribe": `<${input.listUnsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }
      : {}),
  });
  const message = composer.compile();
  // Real defect fixed here: nodemailer's MimeNode DROPS the Bcc header from the
  // built message unless keepBcc is set (its SMTP/sendmail transports set it
  // themselves, because they deliver using a separate envelope). The Gmail API
  // has no separate envelope — it delivers to exactly what the raw message's
  // To/Cc/Bcc headers say — so without this the Bcc recipients were silently
  // discarded and every "bcc" send (the New Sale team notification, the
  // booking-confirmation staff copy) reached only its "to" address. Gmail
  // removes the Bcc header from the copies it delivers, so To/Cc recipients
  // still never see who was blind-copied.
  message.keepBcc = true;
  const buffer = await message.build();
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

const MAX_RATE_LIMIT_BACKOFF_MS = 24 * 60 * 60_000;

/**
 * Gmail's own advice about when to try again: the Retry-After header (seconds, or an HTTP date), or the "Retry after <ISO time>" sentence Google puts in a
 * userRateLimitExceeded message. Anything else (or a time in the past, or absurdly far away) falls back to a safe default; the result is always bounded.
 */
export function parseRetryAfterMs(header: string | null | undefined, body: unknown, now = Date.now()): number {
  const clamp = (ms: number) => (Number.isFinite(ms) && ms > 0 ? Math.min(Math.max(ms, 60_000), MAX_RATE_LIMIT_BACKOFF_MS) : DEFAULT_RATE_LIMIT_BACKOFF_MS);
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return clamp(seconds * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return clamp(at - now);
  }
  const message = body && typeof body === "object" ? (body as { error?: { message?: unknown } }).error?.message : undefined;
  const match = typeof message === "string" ? /retry after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i.exec(message) : null;
  if (match) {
    const at = Date.parse(match[1]);
    if (Number.isFinite(at)) return clamp(at - now);
  }
  return DEFAULT_RATE_LIMIT_BACKOFF_MS;
}

/** Classifies a non-2xx Gmail API response into the right user-facing
 * outcome without exposing raw API/error details to the caller. */
function classifyGmailApiFailure(status: number, body: unknown): { code: "REAUTH_REQUIRED" | "SEND_FAILED"; error: string; rateLimited?: boolean } {
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
  if (status === 429 || reason === "rateLimitExceeded" || reason === "quotaExceeded" || reason === "userRateLimitExceeded" || reason === "dailyLimitExceeded") {
    return { code: "SEND_FAILED", error: "Gmail is temporarily unable to send (rate limit reached). Please try again shortly.", rateLimited: true };
  }
  return { code: "SEND_FAILED", error: "Gmail could not send this email. Please try again." };
}

/**
 * Can this account's Gmail send RIGHT NOW? Answered without sending anything and without touching the Gmail API: the connection must exist and
 * not be REVOKED, Google must have granted the send scope, and the stored refresh token must be decryptable with the current key and OAuth
 * config (the same three failures sendViaGmail turns into NOT_CONNECTED / REAUTH_REQUIRED). With `verifyToken` it also asks Google's token
 * endpoint for an access token (no mail is sent): `invalid_grant` marks the connection REVOKED exactly like a real send would; any other
 * refresh error (network, Google outage) is NOT proof the account is broken, so it reports TEMPORARILY_UNAVAILABLE (not "connect Gmail") and is NOT ready:
 * sending ability was not verified. A successful refresh is still no guarantee that a later send succeeds (rate limits, quota), which is why callers must
 * keep handling send failures. Never returns or logs token material.
 */
/**
 * Why Gmail cannot send right now, as distinct situations (each needs a different instruction for the user):
 *   NOT_CONNECTED          - no Gmail connection exists for the sending account: connect Gmail.
 *   REAUTH_REQUIRED        - the connection exists but Google no longer honours it (revoked, expired, undecryptable): reconnect Gmail.
 *   MISSING_PERMISSION     - Google did not grant the "send email" permission: reconnect and tick the send permission.
 *   TEMPORARILY_UNAVAILABLE- Google's token service could not be reached or failed: nothing is wrong with the connection, try again shortly.
 */
export type GmailReadinessFailure = "NOT_CONNECTED" | "REAUTH_REQUIRED" | "MISSING_PERMISSION" | "TEMPORARILY_UNAVAILABLE";
export type GmailReadiness =
  | { ready: true; verified: boolean }
  | { ready: false; code: GmailReadinessFailure; error: string };

const MISSING_PERMISSION_MESSAGE = "Gmail is connected, but permission to send email was not granted. Reconnect Gmail and allow sending.";
const UNAVAILABLE_MESSAGE = "Gmail could not be checked right now. This is usually temporary - try again in a moment.";

export async function checkGmailSendReadiness(accountId: string, options: { verifyToken?: boolean } = {}): Promise<GmailReadiness> {
  const connection = await prisma.gmailConnection.findUnique({
    where: { accountId },
    select: { status: true, scopes: true, encryptedRefreshToken: true },
  });
  if (!connection) return { ready: false, code: "NOT_CONNECTED", error: NOT_CONNECTED_MESSAGE };
  if (connection.status === "REVOKED") return { ready: false, code: "REAUTH_REQUIRED", error: REAUTH_MESSAGE };
  if (!connection.scopes.includes(GMAIL_SEND_SCOPE)) return { ready: false, code: "MISSING_PERMISSION", error: MISSING_PERMISSION_MESSAGE };

  let client: OAuth2Client;
  try {
    client = new OAuth2Client(getGoogleClientId(), getGoogleClientSecret());
    client.setCredentials({ refresh_token: decryptRefreshToken(connection.encryptedRefreshToken) });
  } catch {
    return { ready: false, code: "REAUTH_REQUIRED", error: REAUTH_MESSAGE };
  }
  if (!options.verifyToken) return { ready: true, verified: false };

  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("no access token returned");
    return { ready: true, verified: true };
  } catch (err) {
    if (isInvalidGrantError(err)) {
      await markRevoked(accountId);
      return { ready: false, code: "REAUTH_REQUIRED", error: REAUTH_MESSAGE };
    }
    // Google's token service failed or could not be reached. That is NOT proof the connection is broken (so do not tell the user to reconnect), but it
    // also means sending ability was not verified, so a caller that asked for verification must not treat the account as ready.
    return { ready: false, code: "TEMPORARILY_UNAVAILABLE", error: UNAVAILABLE_MESSAGE };
  }
}

export async function sendViaGmail(input: GmailSendInput): Promise<GmailSendResult> {
  const connection = await prisma.gmailConnection.findUnique({ where: { accountId: input.accountId } });
  if (!connection) {
    return { ok: false, code: "NOT_CONNECTED", error: NOT_CONNECTED_MESSAGE };
  }
  if (connection.status === "REVOKED") {
    return { ok: false, code: "REAUTH_REQUIRED", error: REAUTH_MESSAGE };
  }

  // Real defect found and fixed: these two lines were the only ones in
  // this function outside any try/catch, yet all three calls can throw —
  // getGoogleClientId()/getGoogleClientSecret() when the OAuth env vars are
  // unset, and decryptRefreshToken() when GMAIL_TOKEN_ENCRYPTION_KEY is
  // missing, malformed, or (the realistic case) has been ROTATED since this
  // connection's refresh token was encrypted, which fails AES-GCM auth-tag
  // verification. That broke this function's documented contract of always
  // resolving to a GmailSendResult and never throwing — with real
  // consequences beyond email: the throw skipped crm-email.ts's EmailLog
  // write (so a failed send left no audit trail at all), and because
  // sendEmail is called from booking creation, quote sending, cancellation
  // and ~10 other flows, a single bad key took those unrelated operations
  // down with it rather than degrading to a clear "couldn't email" result.
  // Now classified as REAUTH_REQUIRED: a rotated key genuinely is fixed by
  // reconnecting Gmail (which re-encrypts a fresh token with the current
  // key), and for the truly-unconfigured case the operator-facing signal is
  // the distinct log line below, never a leaked key or error detail.
  let client: OAuth2Client;
  try {
    client = new OAuth2Client(getGoogleClientId(), getGoogleClientSecret());
    client.setCredentials({ refresh_token: decryptRefreshToken(connection.encryptedRefreshToken) });
  } catch {
    // Deliberately never logs the caught error — it can carry key/token
    // material or configuration detail.
    console.error("[gmail-send] GMAIL_CREDENTIALS_UNUSABLE (OAuth config missing, or token encryption key missing/rotated)");
    return { ok: false, code: "REAUTH_REQUIRED", error: REAUTH_MESSAGE };
  }

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
    listUnsubscribeUrl: input.listUnsubscribeUrl,
  });

  try {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
      // Without a deadline a hung connection would hold the caller (and a sequence worker's claim) indefinitely. A timeout is an UNKNOWN outcome, below.
      signal: AbortSignal.timeout(GMAIL_SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const { code, error, rateLimited } = classifyGmailApiFailure(response.status, body);
      if (code === "REAUTH_REQUIRED") await markRevoked(input.accountId);
      if (rateLimited) {
        // Provider feedback, not a guess: remember that Gmail asked this mailbox to slow down, so the sequence sender waits instead of hammering it.
        const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"), body);
        await prisma.gmailConnection.update({ where: { accountId: input.accountId }, data: { sendBlockedUntil: new Date(Date.now() + retryAfterMs) } }).catch(() => undefined);
        return { ok: false, code, error, rateLimited: true, retryAfterMs };
      }
      // A 5xx means Gmail itself failed while handling the request; whether it had already queued the message is not knowable. 4xx answers are definite.
      return response.status >= 500 ? { ok: false, code, error, ambiguous: true } : { ok: false, code, error };
    }

    // Gmail ACCEPTED the message (2xx). An unreadable body must not turn that into a failure - the message is gone, and reporting a failure here would make
    // a retry send it a second time.
    const data = (await response.json().catch(() => null)) as { id?: string; threadId?: string } | null;
    return {
      ok: true,
      messageId: typeof data?.id === "string" && data.id ? data.id : "accepted-without-id",
      ...(typeof data?.threadId === "string" && data.threadId ? { threadId: data.threadId } : {}),
    };
  } catch {
    console.error("[gmail-send] request to Gmail API failed");
    // The request was sent (or may have been) and no answer arrived: timeout, reset connection, aborted. The message may or may not have been delivered.
    return { ok: false, code: "SEND_FAILED", error: "Could not confirm that Gmail sent this email (no response). It may or may not have been sent.", ambiguous: true };
  }
}
