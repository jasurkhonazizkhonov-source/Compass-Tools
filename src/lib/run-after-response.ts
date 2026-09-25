import { after } from "next/server";

/**
 * Runs non-critical follow-up work after the HTTP response has been sent (on
 * Vercel the platform keeps the function alive until it finishes). Outside a
 * request scope — unit/integration tests, scripts — after() throws, and the
 * work runs inline instead so it is never silently dropped.
 *
 * The task must handle its own errors: nothing awaits it in the request path.
 */
export async function runAfterResponse(task: () => Promise<void>): Promise<void> {
  try {
    after(task);
  } catch {
    await task();
  }
}
