import { createHash } from "node:crypto";

/**
 * The ContactInquiry id for one website "Get In Touch" submission, derived from the submission key the website sends (`submissionId`). The same
 * idea as deriveWebsiteLeadId for flight requests: because the primary key is a pure function of (company, inbox, key), a retry, a double click or a
 * second request whose first answer was lost lands on the SAME row, so a message can never be stored twice. No schema change is needed.
 *
 * The company and the inquiry SOURCE are part of the input, so the same key sent to two inboxes, or by two companies, can never collide. The key
 * is chosen by the website (a random per-form value mixed with a hash of the message), so two different messages never share one.
 *
 * Shape: "c" + 24 hex characters, the same as the cuid() ids the CRM generates, so nothing treats it specially. The namespace string is an internal
 * hash input only; it is never shown or sent anywhere.
 */
export function deriveInquiryId(companyId: string, source: string, submissionKey: string): string {
  return "c" + createHash("sha256").update(`compass-tools:contact-inquiry:${companyId}:${source}:${submissionKey}`).digest("hex").slice(0, 24);
}
