// Recipient rules for the customer-facing "Send / Resend Airline Confirmation Numbers" email.
// Deliberately independent of the internal "Notify Team of a New Sale" recipient logic
// (booking-notification.ts): that one blind-copies CRM staff; this one addresses ONLY customer
// email addresses chosen from the verified set of addresses stored for the booking.
import { z } from "zod";

export type AirlineConfirmationRecipientSource = "booking-form" | "contact";

export type AirlineConfirmationRecipientOption = {
  /** Normalized (trimmed, lower-cased) address. */
  email: string;
  sources: AirlineConfirmationRecipientSource[];
};

const emailSchema = z.string().email();

/** Trim + lower-case + validate. Returns null for anything that is not one plain, valid address
 * (display names, lists, control characters and CR/LF header-injection attempts all fail). */
export function normalizeRecipientEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > 254) return null;
  if (/[\s,;<>()"\\\u0000-\u001f]/.test(value)) return null;
  return emailSchema.safeParse(value).success ? value : null;
}

/**
 * Every address this booking's customer is known by: the email entered on the signed Booking
 * Form first, then the Contact's primary and additional addresses. Deduplicated case-insensitively
 * (an address in both places is one entry with both sources); invalid stored values are dropped.
 * No CRM user address ever enters this list — it is built only from customer-owned fields.
 *
 * Default selection (documented rule, covered by tests): the signed Booking Form address when it is
 * valid — that is who the confirmation has always gone to — otherwise the Contact's primary address.
 * Nothing else is pre-selected, so a send is always to explicitly chosen addresses.
 */
export function buildRecipientOptions(input: {
  bookingFormEmail: string | null | undefined;
  contactPrimaryEmail: string | null | undefined;
  contactEmails: Array<{ email: string; isPrimary?: boolean }>;
}): { options: AirlineConfirmationRecipientOption[]; defaultSelected: string[] } {
  const byEmail = new Map<string, AirlineConfirmationRecipientOption>();
  const add = (raw: unknown, source: AirlineConfirmationRecipientSource) => {
    const email = normalizeRecipientEmail(raw);
    if (!email) return;
    const existing = byEmail.get(email);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      byEmail.set(email, { email, sources: [source] });
    }
  };

  add(input.bookingFormEmail, "booking-form");
  const primaryFirst = [...input.contactEmails].sort((a, b) => Number(!!b.isPrimary) - Number(!!a.isPrimary));
  add(input.contactPrimaryEmail, "contact");
  for (const row of primaryFirst) add(row.email, "contact");

  const options = [...byEmail.values()];
  const bookingForm = normalizeRecipientEmail(input.bookingFormEmail);
  const contactPrimary = normalizeRecipientEmail(input.contactPrimaryEmail) ?? normalizeRecipientEmail(input.contactEmails.find((e) => e.isPrimary)?.email);
  const defaultEmail = bookingForm ?? contactPrimary;
  return { options, defaultSelected: defaultEmail ? [defaultEmail] : [] };
}

/**
 * Validates the addresses a user selected against the verified options for this booking. Every
 * entry must normalize to an address in `options` — an arbitrary typed-in address, or one that
 * only looks different (case/whitespace), is matched or rejected, never passed through. Duplicates
 * collapse. Returns the normalized, deduplicated list in option order.
 */
export function resolveSelectedRecipients(
  requested: unknown,
  options: AirlineConfirmationRecipientOption[]
): { ok: true; recipients: string[] } | { ok: false; error: string } {
  if (!Array.isArray(requested) || requested.length === 0) return { ok: false, error: "Select at least one email address." };
  const allowed = new Set(options.map((o) => o.email));
  const picked = new Set<string>();
  for (const raw of requested) {
    const email = normalizeRecipientEmail(raw);
    if (!email || !allowed.has(email)) {
      return { ok: false, error: "One of the selected email addresses is not on file for this booking. Reopen this dialog and choose from the list." };
    }
    picked.add(email);
  }
  if (picked.size === 0) return { ok: false, error: "Select at least one email address." };
  return { ok: true, recipients: options.map((o) => o.email).filter((e) => picked.has(e)) };
}
