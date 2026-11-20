// Customer-email masking. Pure and dependency-free so the SAME function is used by the server (the only place a masked value is produced for a restricted
// user - a masked string is what crosses to the browser) and by tests.
//
// Format: the first and last character of the local part are kept, everything between becomes asterisks, and the domain is preserved.
//   john.smith@gmail.com -> j********h@gmail.com
//   ab@example.com       -> a*@example.com     (a one-character result never reveals the whole local part)
//   a@example.com        -> *@example.com
// Anything that is not a plausible address is returned fully masked, never as-is.

const MAX_STARS = 12;

export function maskCustomerEmail(email: string | null | undefined): string {
  if (typeof email !== "string") return "";
  const trimmed = email.trim();
  if (!trimmed) return "";
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return "********";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const chars = [...local];
  if (chars.length === 1) return `*@${domain}`;
  if (chars.length === 2) return `${chars[0]}*@${domain}`;
  const stars = "*".repeat(Math.min(chars.length - 2, MAX_STARS));
  return `${chars[0]}${stars}${chars[chars.length - 1]}@${domain}`;
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Masks every address embedded in free text (activity descriptions such as "Primary email updated to x@y.com", note bodies, email-log recipient lists). */
export function maskEmailsInText(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return text.replace(EMAIL_IN_TEXT, (m) => maskCustomerEmail(m));
}

/** What a composer is given for each address of a customer: an opaque id the SERVER resolves at send time, a label, and (only if the viewer may see it) the address. */
export type RecipientOption = { id: string; display: string; address: string | null };

/** The business-day allowance every non-privileged customer-facing user gets. One constant, used by the server and echoed to the UI. */
export const DAILY_EMAIL_REVEAL_LIMIT = 5;
