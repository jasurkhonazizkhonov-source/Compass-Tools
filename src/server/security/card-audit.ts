import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/request-ip";

// One place that writes card-vault audit events, so every event has the same
// shape and none can carry card data:
//   actor, action, record id, result, IP (only when a trusted proxy resolved
//   one), a short user-agent, and a correlation id for tying an event to a
//   request in the host's logs.
//
// Privacy: the IP and user agent are recorded because these are security
// events about who touched a card; both are capped and neither is used for
// anything except investigation. Metadata values are additionally scrubbed of
// anything card-number-shaped as defence in depth — callers already never pass
// a PAN, and the CVV/CVC does not exist anywhere in this application.
//
// The rows are append-only at the database (migration
// 20260926000400_card_vault_hardening): a trigger rejects UPDATE and DELETE of
// card-vault audit rows by the application role. That resists application-level
// tampering and mistakes; it does not stop someone who can alter the database
// schema, so ship the table to a write-once log store if that threat matters.

export type CardAuditAction =
  | "PAYMENT_METHOD_CREATED"
  | "PAYMENT_METHOD_EDITED"
  | "PAYMENT_METHOD_REMOVED"
  | "PAYMENT_METHOD_PURGED"
  | "PAYMENT_METHOD_MUTATION_DENIED"
  | "PAYMENT_METHOD_MUTATION_RATE_LIMITED"
  | "PAYMENT_METHOD_REVEALED"
  | "PAYMENT_METHOD_REVEAL_DENIED"
  | "PAYMENT_METHOD_REVEAL_RATE_LIMITED"
  | "CARD_ENCRYPTION_FAILED"
  | "CARD_DECRYPTION_FAILED"
  | "CARD_KEYS_ROTATED"
  | "PAYMENT_PERMISSIONS_CHANGED";

const CARD_SHAPED = /\b(?:\d[ -]?){13,19}\b/g;

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(CARD_SHAPED, "[redacted]").slice(0, 300);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
}

async function requestContext(): Promise<{ ip: string | null; userAgent: string | null; correlationId: string }> {
  try {
    const h = await headers();
    return {
      ip: getClientIp(h) ?? null,
      userAgent: (h.get("user-agent") ?? "").slice(0, 160) || null,
      correlationId: (h.get("x-vercel-id") ?? h.get("x-request-id") ?? crypto.randomUUID()).slice(0, 100),
    };
  } catch {
    // headers() throws outside a request (scripts, some test harnesses) — an audit event must still be written.
    return { ip: null, userAgent: null, correlationId: crypto.randomUUID() };
  }
}

export async function auditCardEvent(params: {
  actorId?: string | null;
  action: CardAuditAction;
  entityId: string;
  /** Defaults to "PaymentMethod". */
  entityType?: string;
  success: boolean;
  reason?: string;
  /** Extra non-sensitive facts (record ids, counts, key ids, last4). Never a PAN. */
  details?: Record<string, unknown>;
}): Promise<void> {
  const ctx = await requestContext();
  await prisma.auditLog.create({
    data: {
      actorId: params.actorId ?? undefined,
      action: params.action,
      entityType: params.entityType ?? "PaymentMethod",
      entityId: params.entityId,
      metadata: scrub({
        ...params.details,
        result: params.success ? "SUCCESS" : "DENIED",
        reason: params.reason ?? null,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      }) as Record<string, string | number | boolean | null | object>,
    },
  });
}
