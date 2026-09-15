// Shared by every call site that needs to log "something failed" without
// ever risking a secret leaking into server logs. Some Prisma/driver error
// messages embed connection-string fragments, query text, or other detail
// that must never reach logs any more than the browser — so this logs ONLY
// the error's constructor name (e.g. "PrismaClientInitializationError"),
// never `err.message`. Originally added in google-auth.ts (Pass 41); moved
// here so src/proxy.ts can use the exact same safe-logging convention for
// its own unguarded database call instead of duplicating the helper.
export function safeErrorTag(err: unknown): string {
  if (err instanceof Error) return err.constructor.name || "Error";
  return typeof err;
}
