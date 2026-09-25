// Records unhandled server errors (500s) as de-duplicated System Health
// incidents, from Next's instrumentation onRequestError hook.
//
// What is deliberately NOT recorded: the error message (Prisma/driver messages
// can embed connection strings or query text), the stack, the request URL or
// query string (a customer link carries its secret token in the path), any
// header or cookie. Only the route PATTERN (e.g. /quote/[token]), the route
// type, a short safe error category and Next's opaque digest.
import { safeErrorTag } from "@/lib/safe-error-log";
import { recordHealthEvent } from "@/server/system/health-events";

export type ServerErrorContext = { routePath?: unknown; routeType?: unknown };

// Error categories that mean "the database is unreachable / out of connections"
// rather than "one query was rejected" (a unique-constraint hit is not an outage).
const DATABASE_OUTAGE_TAG = /PrismaClientInitializationError|P10\d\d|P2024|DatabaseNotReachable|TooManyConnections|53300|ConnectionClosed|ConnectionRefused/;

export function classifyServerError(err: unknown): { tag: string; databaseOutage: boolean } {
  const tag = safeErrorTag(err);
  return { tag, databaseOutage: DATABASE_OUTAGE_TAG.test(tag) };
}

function safeRoute(value: unknown): string {
  // A route PATTERN only. Anything else (or anything containing a query
  // string or a token-shaped segment) collapses to a fixed placeholder.
  if (typeof value !== "string") return "unknown";
  const cleaned = value.split("?")[0].slice(0, 120);
  return /^[A-Za-z0-9/_[\].()@-]+$/.test(cleaned) ? cleaned : "unknown";
}

export async function recordServerError(err: unknown, context: ServerErrorContext): Promise<void> {
  const { tag, databaseOutage } = classifyServerError(err);
  const route = safeRoute(context.routePath);
  const routeType = typeof context.routeType === "string" ? context.routeType.slice(0, 20) : "unknown";
  const digest = typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest).slice(0, 20) : undefined;

  await recordHealthEvent({
    type: databaseOutage ? "SERVER_DATABASE_ERROR" : "SERVER_ERROR",
    category: "server",
    severity: databaseOutage ? "CRITICAL" : "WARNING",
    discriminator: databaseOutage ? "database" : `${routeType}:${route}`,
    message: databaseOutage
      ? `The database could not be reached or was out of connections while serving a request (${tag}).`
      : `An unhandled error occurred in ${routeType} ${route} (${tag}).`,
    metadata: { route, routeType, failure: tag, digest },
  });
}
