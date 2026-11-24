// Decides whether ONE message found in a conversation that a sequence email started is a genuine reply from the customer. Pure: no network, no database, so every rule is
// testable. The sync (src/server/sequence-reply-sync.ts) feeds it message METADATA only (Gmail labels and a few headers - never a body).
//
// A message is a reply only when ALL of these hold:
//   1. It is not one of our own messages: not labelled SENT or DRAFT, and not from the connected mailbox itself (so the CRM's own sequence emails, and anything the agent
//      sends from the mailbox in that conversation, never stop a sequence).
//   2. It is not machine-generated: no Auto-Submitted / Precedence / auto-response headers, not a delivery-status or read-receipt report, not from a mailer-daemon or
//      no-reply address. An out-of-office answer, a bounce or a delivery notification is not a customer deciding to talk to us.
//   3. It is not the message we sent (its Gmail id is never one of the ids we recorded for our own sends).
// Anything else in a tracked conversation is a human answering our email, whichever address they used (a customer may reply from a second address or an assistant may
// answer for them) - the conversation, not the From address, is what ties it to our email.

export type InboundMessageMeta = {
  id: string;
  threadId: string;
  /** Gmail system and user labels, e.g. INBOX, SENT, DRAFT, SPAM. */
  labelIds: readonly string[];
  /** Header name (any case) -> value. Only the headers listed in REPLY_METADATA_HEADERS are ever requested. */
  headers: Readonly<Record<string, string | undefined>>;
  /** Gmail's internalDate (ms since epoch) when known. */
  internalDateMs?: number;
};

/** The ONLY headers the sync asks Gmail for. Subject is deliberately absent: nothing here needs it, and not requesting it keeps the data collected to the minimum. */
export const REPLY_METADATA_HEADERS = ["From", "Auto-Submitted", "Precedence", "X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress", "X-Failed-Recipients", "Return-Path", "Content-Type"] as const;

export type ReplyVerdict =
  | { kind: "reply"; fromEmail: string }
  | { kind: "own" }
  | { kind: "automated"; reason: string }
  | { kind: "known-message" };

const header = (m: InboundMessageMeta, name: string): string => {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(m.headers)) if (k.toLowerCase() === lower && typeof v === "string") return v.trim();
  return "";
};

/** "Ann Lee <Ann@Example.com>" -> "ann@example.com"; a bare address works too; anything without an address -> "". */
export function extractEmailAddress(value: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const raw = angle ? angle[1] : (/[^\s<>"',;]+@[^\s<>"',;]+/.exec(value)?.[0] ?? "");
  return raw.replace(/^mailto:/i, "").toLowerCase();
}

const MACHINE_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|donotreply|bounce[s]?|bounces\+.*|mailer|notification[s]?|auto-?reply|autoresponder)([._+-].*)?@/i;

/** Why a message is machine-generated, or null when it looks like a person wrote it. */
export function automatedReason(m: InboundMessageMeta): string | null {
  const autoSubmitted = header(m, "Auto-Submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return "auto-submitted";
  const precedence = header(m, "Precedence").toLowerCase();
  if (["bulk", "junk", "list", "auto_reply", "auto-reply"].includes(precedence)) return "precedence";
  if (header(m, "X-Autoreply") || header(m, "X-Autorespond")) return "auto-response";
  if (header(m, "X-Auto-Response-Suppress")) return "auto-response";
  if (header(m, "X-Failed-Recipients")) return "delivery-failure";
  // An empty return path (<>) is how a bounce is sent.
  if (/^<\s*>$/.test(header(m, "Return-Path"))) return "bounce";
  if (/multipart\/report|delivery-status|disposition-notification/i.test(header(m, "Content-Type"))) return "delivery-report";
  const from = extractEmailAddress(header(m, "From"));
  if (from && MACHINE_SENDER.test(from)) return "machine-sender";
  return null;
}

/**
 * @param ownAddresses addresses that are US: the connected Gmail mailbox and the sending agent's CRM address (lower-case).
 * @param knownMessageIds Gmail ids of the messages the CRM itself sent in these conversations.
 */
export function classifyInboundMessage(m: InboundMessageMeta, ownAddresses: readonly string[], knownMessageIds: ReadonlySet<string> = new Set()): ReplyVerdict {
  if (knownMessageIds.has(m.id)) return { kind: "known-message" };
  if (m.labelIds.includes("SENT") || m.labelIds.includes("DRAFT")) return { kind: "own" };
  const fromEmail = extractEmailAddress(header(m, "From"));
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  if (fromEmail && own.has(fromEmail)) return { kind: "own" };
  const automated = automatedReason(m);
  if (automated) return { kind: "automated", reason: automated };
  // No usable sender at all: cannot call it a person's reply.
  if (!fromEmail) return { kind: "automated", reason: "no-sender" };
  return { kind: "reply", fromEmail };
}
