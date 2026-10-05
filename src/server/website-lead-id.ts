import { createHash } from "node:crypto";

/**
 * The Lead id for one website flight-request submission, derived from the form's submission key. It is the SAME
 * derivation the public website's own database write uses (src/lib/submission-id.ts there), so a submission that reaches
 * the CRM by either route — the website's direct write or this CRM's /api/public/lead-capture — lands on the SAME primary
 * key: a retry, a double-submit or a mixed-route repeat can never create a second lead. The namespace string is an
 * internal hash input only; it is never shown or sent anywhere. Do not change it without changing the website too.
 *
 * Shape: "c" + 24 hex characters, the same as the cuid() ids the CRM generates, so nothing treats it specially.
 */
export function deriveWebsiteLeadId(submissionId: string): string {
  return "c" + createHash("sha256").update(`business-flights-travel:flight-request:${submissionId}`).digest("hex").slice(0, 24);
}
