/**
 * True when DISABLE_IN_PROCESS_POLLER is set to a truthy value ("true", "1", "yes", "on" - case-insensitive, whitespace ignored). Anything else, including
 * unset, leaves the in-process task-due poller ON, so a deployment that has not heard of this switch behaves exactly as before. Kept out of
 * src/instrumentation.ts (which should export only the hooks Next looks for) so it can be unit-tested.
 */
export function inProcessPollerDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["true", "1", "yes", "on"].includes((env.DISABLE_IN_PROCESS_POLLER ?? "").trim().toLowerCase());
}
