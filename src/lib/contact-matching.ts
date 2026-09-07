import { normalizePhoneNumberWithRecovery } from "@/lib/phone";

/**
 * The one canonical "does a phone/email match an existing Contact" where-
 * fragment builder — used by createLead's dedup flow (leads.ts) and by the
 * Get in Touch inquiry-matching flow (contact-inquiries.ts) alike, so the
 * two never drift into checking duplicates differently. Matches both the
 * normalized (E.164, attempting the Excel-mangled-NANP recovery — Part 10)
 * and raw forms of the phone, since older Contact rows may predate
 * normalization.
 */
export function duplicateContactWhere(phone: string | undefined, email: string | undefined) {
  const orConditions: Array<Record<string, unknown>> = [];
  if (phone) {
    const normalized = normalizePhoneNumberWithRecovery(phone);
    const candidates = normalized && normalized !== phone ? [normalized, phone] : [phone];
    for (const candidate of candidates) {
      orConditions.push({ primaryPhone: candidate });
      orConditions.push({ phones: { some: { number: candidate } } });
    }
  }
  if (email) {
    // Case-insensitive — "Jane@Example.com" and "jane@example.com" must
    // match the same Contact regardless of how either was originally
    // typed/stored (older rows may predate lowercasing on write).
    const trimmed = email.trim();
    orConditions.push({ primaryEmail: { equals: trimmed, mode: "insensitive" } });
    orConditions.push({ emails: { some: { email: { equals: trimmed, mode: "insensitive" } } } });
  }
  return orConditions;
}
