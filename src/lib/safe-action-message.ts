/**
 * Next.js replaces the message of an error thrown from a Server Action with an
 * opaque digest in production (so internals never leak). Showing that to a user
 * is noise, so when a message looks masked — or is empty — show the caller's
 * fallback instead. Messages that were deliberately RETURNED (not thrown) never
 * need this.
 */
export function safeActionMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : "";
  if (!message || /omitted in production|Server Components render|Minified React error|digest/i.test(message)) return fallback;
  return message;
}
