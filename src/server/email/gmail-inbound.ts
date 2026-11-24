import { OAuth2Client } from "google-auth-library";
import { prisma } from "@/lib/prisma";
import { getGoogleClientId, getGoogleClientSecret } from "@/server/auth/google-config";
import { decryptRefreshToken } from "@/server/security/gmail-token-encryption";
import { REPLY_METADATA_HEADERS, type InboundMessageMeta } from "@/lib/reply-detection";

// A minimal, READ-ONLY Gmail client for reply detection. It uses the gmail.metadata scope, so Gmail itself refuses to return a message body or attachment: what comes
// back is labels and the handful of headers in REPLY_METADATA_HEADERS. It is only ever pointed at conversations that one of the CRM's own sequence emails started
// (by thread id) plus Gmail's change list (which carries ids and labels, no content); it never searches or lists the mailbox.

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const TIMEOUT_MS = 20_000;

export type GmailInboundErrorCode =
  | "AUTH" // the refresh token no longer works (revoked / expired): the connection must be reconnected
  | "SCOPE" // Google did not grant the metadata permission (or it was removed)
  | "HISTORY_EXPIRED" // the saved change-list position is too old for Gmail to answer
  | "RATE" // Gmail asked us to slow down
  | "UNAVAILABLE"; // network error, timeout or a 5xx: temporary

export class GmailInboundError extends Error {
  constructor(public readonly code: GmailInboundErrorCode) {
    super(code); // the category only: never a provider payload, token or address
    this.name = "GmailInboundError";
  }
}

export type HistoryPage = {
  /** Messages that arrived in the mailbox since the cursor: ids and labels only. */
  added: { id: string; threadId: string; labelIds: string[] }[];
  /** Gmail's newest history id as of this answer (the next cursor once every page was read). */
  historyId: string;
  nextPageToken?: string;
};

export type GmailInboundApi = {
  /** Gmail's current history id: the position "from now on". */
  currentHistoryId(): Promise<string>;
  listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage>;
  getMessage(id: string): Promise<InboundMessageMeta | null>;
  /** Every message of one conversation (metadata only); [] when the conversation no longer exists. */
  getThread(threadId: string): Promise<InboundMessageMeta[]>;
};

type RawHeader = { name?: string; value?: string };
type RawMessage = { id?: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: RawHeader[] } };

export function toMessageMeta(raw: RawMessage): InboundMessageMeta | null {
  if (!raw || typeof raw.id !== "string" || typeof raw.threadId !== "string") return null;
  const headers: Record<string, string> = {};
  for (const h of raw.payload?.headers ?? []) if (typeof h?.name === "string" && typeof h.value === "string") headers[h.name] = h.value;
  const ms = Number(raw.internalDate);
  return { id: raw.id, threadId: raw.threadId, labelIds: Array.isArray(raw.labelIds) ? raw.labelIds.filter((l) => typeof l === "string") : [], headers, ...(Number.isFinite(ms) ? { internalDateMs: ms } : {}) };
}

const metadataQuery = () => `format=metadata&${REPLY_METADATA_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join("&")}`;

function classifyStatus(status: number, body: unknown): GmailInboundErrorCode {
  if (status === 401) return "AUTH";
  const reason = (body as { error?: { errors?: Array<{ reason?: string }>; status?: string } } | null)?.error;
  const why = reason?.errors?.[0]?.reason ?? reason?.status;
  if (status === 403 && (why === "insufficientPermissions" || why === "PERMISSION_DENIED" || why === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) return "SCOPE";
  if (status === 429 || why === "rateLimitExceeded" || why === "userRateLimitExceeded" || why === "quotaExceeded") return "RATE";
  return "UNAVAILABLE";
}

/** The real client. `fetchImpl` is injectable so tests never touch the network. */
export function createGmailInboundApi(accessToken: string, fetchImpl: typeof fetch = fetch): GmailInboundApi {
  async function get(path: string): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetchImpl(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new GmailInboundError("UNAVAILABLE");
    }
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  return {
    async currentHistoryId() {
      const { status, body } = await get("/profile");
      const id = (body as { historyId?: unknown } | null)?.historyId;
      if (status < 200 || status >= 300 || (typeof id !== "string" && typeof id !== "number")) throw new GmailInboundError(classifyStatus(status, body));
      return String(id);
    },

    async listHistory(startHistoryId, pageToken) {
      const q = `startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded&maxResults=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const { status, body } = await get(`/history?${q}`);
      if (status === 404) throw new GmailInboundError("HISTORY_EXPIRED");
      if (status < 200 || status >= 300) throw new GmailInboundError(classifyStatus(status, body));
      const data = body as { history?: Array<{ messagesAdded?: Array<{ message?: { id?: string; threadId?: string; labelIds?: string[] } }> }>; historyId?: unknown; nextPageToken?: string };
      const added: HistoryPage["added"] = [];
      for (const h of data.history ?? []) {
        for (const a of h.messagesAdded ?? []) {
          const m = a.message;
          if (m && typeof m.id === "string" && typeof m.threadId === "string") added.push({ id: m.id, threadId: m.threadId, labelIds: Array.isArray(m.labelIds) ? m.labelIds : [] });
        }
      }
      return { added, historyId: String(data.historyId ?? startHistoryId), ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
    },

    async getMessage(id) {
      const { status, body } = await get(`/messages/${encodeURIComponent(id)}?${metadataQuery()}`);
      if (status === 404) return null; // deleted since: nothing to judge
      if (status < 200 || status >= 300) throw new GmailInboundError(classifyStatus(status, body));
      return toMessageMeta(body as RawMessage);
    },

    async getThread(threadId) {
      const { status, body } = await get(`/threads/${encodeURIComponent(threadId)}?${metadataQuery()}`);
      if (status === 404) return [];
      if (status < 200 || status >= 300) throw new GmailInboundError(classifyStatus(status, body));
      const messages = (body as { messages?: RawMessage[] } | null)?.messages ?? [];
      return messages.map(toMessageMeta).filter((m): m is InboundMessageMeta => m !== null);
    },
  };
}

/**
 * An API client for one stored connection: decrypts its refresh token and exchanges it for an access token. A token Google no longer honours (invalid_grant) marks
 * the connection REVOKED exactly like a failed send does; anything else is reported as a temporary problem. Never logs or returns token material.
 */
export async function inboundApiForConnection(connection: { accountId: string; encryptedRefreshToken: string }): Promise<GmailInboundApi> {
  let client: OAuth2Client;
  try {
    client = new OAuth2Client(getGoogleClientId(), getGoogleClientSecret());
    client.setCredentials({ refresh_token: decryptRefreshToken(connection.encryptedRefreshToken) });
  } catch {
    throw new GmailInboundError("AUTH");
  }
  try {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("no access token");
    return createGmailInboundApi(token);
  } catch (err) {
    if (/invalid_grant/i.test(err instanceof Error ? err.message : String(err))) {
      await prisma.gmailConnection.update({ where: { accountId: connection.accountId }, data: { status: "REVOKED", revokedAt: new Date() } }).catch(() => undefined);
      throw new GmailInboundError("AUTH");
    }
    throw new GmailInboundError("UNAVAILABLE");
  }
}
