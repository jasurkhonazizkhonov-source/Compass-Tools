/**
 * A Server Action rejection that the action itself already handled correctly:
 * invalid input, "not found", an authorization denial, or a business-rule
 * precondition — thrown deliberately so the calling component's `.catch()`
 * shows the message as a toast. This is normal, expected control flow, not a
 * defect.
 *
 * Why this class exists: Next.js calls `onRequestError` (instrumentation.ts →
 * recordServerError) for EVERY error a Server Action throws, whether or not
 * the action's own logic (and the client) already handles it correctly —
 * Next has no way to tell "an intentional business rejection" apart from "an
 * actual crash," because both are just a thrown `Error`. Without this
 * distinction, ordinary, working validation (e.g. "This quote can no longer
 * be canceled directly...") gets recorded as a "server error" System Health
 * incident purely because a user (or an agent testing a workflow) triggered
 * it a few times — a real, observed false positive
 * (CHECK_SERVER_ERROR "unhandled error… /quotes/[id]").
 *
 * Using this class is not "hiding" the error: the thrown message still
 * reaches the client exactly as before (nothing about the request/response
 * path changes), and call sites that already audit a denial (e.g.
 * `deleteQuote`) still do. It only tells the health/incident layer "this was
 * already handled — do not report it as an application defect."
 *
 * Scope: used by the Server Actions reachable from the CRM quote detail page
 * (`src/server/actions/quotes.ts`, `cancellation.ts`, `exchange.ts`) — the
 * files actually implicated by the reported incident. Other action files
 * still throw a plain `Error` for the same kind of expected condition and
 * would benefit from the same treatment; that is a separate, larger change
 * left for a follow-up rather than an unrelated rewrite bundled into this fix.
 */
export class ExpectedActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectedActionError";
  }
}

export function isExpectedActionError(err: unknown): boolean {
  return err instanceof ExpectedActionError || (err instanceof Error && err.name === "ExpectedActionError");
}
