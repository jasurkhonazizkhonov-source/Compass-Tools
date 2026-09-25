// Structured System Health incidents (the HealthEvent table).
//
// Plain server module — deliberately NOT a "use server" file, so nothing here
// is a network-callable endpoint. Reuses the existing Notification model for
// Admin alerts rather than adding a parallel alerting system.
//
// Three properties matter more than anything else here:
//   1. Recording can NEVER break the request that triggered it. Every public
//      function swallows its own failure (logging only a safe tag).
//   2. Nothing sensitive is ever stored. Messages and metadata pass through
//      `sanitizeMessage` / `sanitizeMetadata` first: no card numbers, tokens,
//      cookies, connection strings, URLs, emails or long opaque strings.
//   3. Repeats collapse. One OPEN row per fingerprint (a partial unique index),
//      bumped atomically by INSERT ... ON CONFLICT, so a failure that happens
//      a thousand times is one incident with occurrenceCount = 1000, not a
//      thousand rows and not a thousand notifications.
import { createHash, randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { safeErrorTag } from "@/lib/safe-error-log";
import type { HealthSeverity } from "@/generated/prisma/client";

/** Resolved incidents (and stale INFO ones) are deleted after this long. */
export const HEALTH_RETENTION_DAYS = 30;
/** A problem that recovers and recurs inside this window re-opens quietly
 * (no fresh Admin notification) — a flapping check must not spam. */
export const HEALTH_RENOTIFY_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Per-instance floor between writes for one fingerprint: a hot failure
 * loop must not turn into a database write per request. */
const RECORD_MIN_INTERVAL_MS = 10_000;

const MAX_MESSAGE_LENGTH = 300;
const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_ITEMS = 10;
const MAX_DEPTH = 2;

// Keys whose VALUES are never stored, whatever they contain.
const SENSITIVE_KEY = /pass|secret|token|cookie|auth|session|card|pan\b|cvv|cvc|key|dsn|credential|connection|url|uri|host|email|phone|address|^ip|ip$|body|header|query|sql|stack/i;

const REDACTIONS: Array<[RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[redacted-url]"], // any scheme://... incl. postgres://user:pw@host
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted-token]"],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted-token]"], // JWT
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[redacted-email]"],
  [/\b(?:\d[ -]?){13,19}\b/g, "[redacted-number]"], // card-number-shaped runs
  [/\b[A-Za-z0-9_+/=-]{32,}\b/g, "[redacted-token]"], // long opaque strings (keys, session ids)
];

/** Removes anything credential-, card- or URL-shaped from free text and caps its length. */
export function sanitizeMessage(input: unknown, max = MAX_MESSAGE_LENGTH): string {
  let text = typeof input === "string" ? input : input == null ? "" : String(input);
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeMessage(value, MAX_STRING_LENGTH);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return null;
    return value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeValue(v, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return null;
    return sanitizeMetadata(value as Record<string, unknown>, depth + 1);
  }
  return null; // functions, symbols, bigint, Date objects — never stored
}

/** Whitelist-by-shape sanitizer for the metadata JSON: drops sensitive keys outright, redacts string values, bounds depth/size. */
export function sanitizeMetadata(input: Record<string, unknown> | undefined | null, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input).slice(0, 25)) {
    if (SENSITIVE_KEY.test(key)) continue;
    out[key.slice(0, 40)] = sanitizeValue(value, depth);
  }
  return out;
}

/** Stable identity of "the same problem": type + category + an optional discriminator (a route pattern, a step name…). */
export function healthFingerprint(type: string, category: string, discriminator?: string): string {
  return createHash("sha256").update(`${type}|${category}|${discriminator ?? ""}`).digest("hex").slice(0, 32);
}

export type RecordHealthEventInput = {
  type: string;
  severity: HealthSeverity;
  category: string;
  message: string;
  /** Distinguishes independent instances of one type (e.g. the route or step). Part of the fingerprint. */
  discriminator?: string;
  metadata?: Record<string, unknown>;
  /** Notify Admins when this opens a NEW incident. Defaults to true for CRITICAL only. */
  notify?: boolean;
};

const lastRecordedAt = new Map<string, number>();

/** Test hook — the per-instance write throttle is module state. */
export function resetHealthEventThrottleForTests() {
  lastRecordedAt.clear();
}

/**
 * Records one observation of a problem. New fingerprint => new OPEN incident;
 * known open fingerprint => lastSeenAt / occurrenceCount bumped (severity only
 * ever escalates while open). Never throws.
 */
export async function recordHealthEvent(input: RecordHealthEventInput, now: number = Date.now()): Promise<{ recorded: boolean; isNew: boolean }> {
  try {
    const fingerprint = healthFingerprint(input.type, input.category, input.discriminator);
    const last = lastRecordedAt.get(fingerprint);
    if (last !== undefined && now - last < RECORD_MIN_INTERVAL_MS) return { recorded: false, isNew: false };
    lastRecordedAt.set(fingerprint, now);
    if (lastRecordedAt.size > 500) lastRecordedAt.clear(); // bounded memory

    const message = sanitizeMessage(input.message);
    const metadata = JSON.stringify(sanitizeMetadata(input.metadata));
    const rows = await prisma.$queryRaw<Array<{ inserted: boolean }>>`
      INSERT INTO "HealthEvent" ("id", "fingerprint", "type", "severity", "category", "message", "metadata", "firstSeenAt", "lastSeenAt", "occurrenceCount")
      VALUES (${randomUUID()}, ${fingerprint}, ${input.type.slice(0, 80)}, ${input.severity}::"HealthSeverity", ${input.category.slice(0, 40)}, ${message}, ${metadata}::jsonb,
              (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC'), 1)
      ON CONFLICT ("fingerprint") WHERE "resolvedAt" IS NULL
      DO UPDATE SET "lastSeenAt" = (now() AT TIME ZONE 'UTC'),
                    "occurrenceCount" = "HealthEvent"."occurrenceCount" + 1,
                    "message" = EXCLUDED."message",
                    "metadata" = EXCLUDED."metadata",
                    "severity" = CASE WHEN EXCLUDED."severity" > "HealthEvent"."severity" THEN EXCLUDED."severity" ELSE "HealthEvent"."severity" END
      RETURNING (xmax = 0) AS "inserted"
    `;
    const isNew = rows[0]?.inserted === true;
    if (isNew && (input.notify ?? input.severity === "CRITICAL")) {
      await notifyAdminsOfNewIncident({ fingerprint, severity: input.severity, message }, now).catch((err) => {
        console.error(`[health] NOTIFY_FAILED (${safeErrorTag(err)})`);
      });
    }
    return { recorded: true, isNew };
  } catch (err) {
    console.error(`[health] RECORD_FAILED (${safeErrorTag(err)})`);
    return { recorded: false, isNew: false };
  }
}

/** Marks every OPEN incident with this type (and optional discriminator) resolved. Never throws. */
export async function resolveHealthEvents(type: string, category: string, discriminator?: string): Promise<number> {
  try {
    const result = await prisma.healthEvent.updateMany({
      where: { fingerprint: healthFingerprint(type, category, discriminator), resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
    return result.count;
  } catch (err) {
    console.error(`[health] RESOLVE_FAILED (${safeErrorTag(err)})`);
    return 0;
  }
}

async function notifyAdminsOfNewIncident(event: { fingerprint: string; severity: HealthSeverity; message: string }, now: number) {
  // Flap guard: this fingerprint was resolved recently => it is the same
  // story, not news. (The just-inserted OPEN row is excluded by resolvedAt.)
  const recentlyResolved = await prisma.healthEvent.count({
    where: { fingerprint: event.fingerprint, resolvedAt: { gte: new Date(now - HEALTH_RENOTIFY_WINDOW_MS) } },
  });
  if (recentlyResolved > 0) return;

  const admins = await prisma.account.findMany({ where: { role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  if (admins.length === 0) return;
  await prisma.notification.createMany({
    data: admins.map((a) => ({
      accountId: a.id,
      type: "SYSTEM_HEALTH",
      title: event.severity === "CRITICAL" ? "System Health: critical issue" : "System Health: attention needed",
      body: `${event.message} — Review System Health.`,
    })),
  });
}

/**
 * Event-driven incidents (recorded where a failure happens, as opposed to
 * CHECK_* incidents which the checks themselves resolve) have no "healthy"
 * signal of their own. One that has not recurred for this long is quiet, so
 * it is marked resolved instead of staying open forever. Never throws.
 */
export const STALE_INCIDENT_HOURS = 24;
export async function resolveStaleHealthEvents(now: number = Date.now()): Promise<number> {
  try {
    const result = await prisma.healthEvent.updateMany({
      where: { resolvedAt: null, NOT: { type: { startsWith: "CHECK_" } }, lastSeenAt: { lt: new Date(now - STALE_INCIDENT_HOURS * 3600_000) } },
      data: { resolvedAt: new Date(now) },
    });
    return result.count;
  } catch (err) {
    console.error(`[health] STALE_RESOLVE_FAILED (${safeErrorTag(err)})`);
    return 0;
  }
}

/** Deletes resolved incidents past retention, plus open INFO noise nobody has seen in that long. Never throws. */
export async function pruneHealthEvents(now: number = Date.now()): Promise<number> {
  try {
    const cutoff = new Date(now - HEALTH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await prisma.healthEvent.deleteMany({
      where: { OR: [{ resolvedAt: { lt: cutoff } }, { severity: "INFO", lastSeenAt: { lt: cutoff } }] },
    });
    return result.count;
  } catch (err) {
    console.error(`[health] PRUNE_FAILED (${safeErrorTag(err)})`);
    return 0;
  }
}

export type HealthEventView = {
  id: string;
  type: string;
  severity: HealthSeverity;
  category: string;
  message: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrenceCount: number;
  resolvedAt: Date | null;
};

/** Open incidents (most severe, then most recent, first) and recent resolved history. Admin surface only. */
export async function listHealthEvents(): Promise<{ open: HealthEventView[]; recentlyResolved: HealthEventView[] }> {
  const select = { id: true, type: true, severity: true, category: true, message: true, firstSeenAt: true, lastSeenAt: true, occurrenceCount: true, resolvedAt: true } as const;
  const [open, recentlyResolved] = await Promise.all([
    prisma.healthEvent.findMany({ where: { resolvedAt: null }, select, orderBy: [{ severity: "desc" }, { lastSeenAt: "desc" }], take: 50 }),
    prisma.healthEvent.findMany({ where: { resolvedAt: { not: null } }, select, orderBy: { resolvedAt: "desc" }, take: 25 }),
  ]);
  return { open, recentlyResolved };
}
