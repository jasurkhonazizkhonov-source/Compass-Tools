import { prisma } from "@/lib/prisma";

// WHO a sequence email goes to, decided in ONE place for every enrollment path (single lead, choose leads, by status, from the Leads / Contacts lists, Enroll All Contacts)
// and re-applied at send time. It reuses the data model that already exists: the contact's primary email (Contact.primaryEmail, the denormalised current primary) and its
// other addresses (ContactEmail). Nothing new is stored: "Primary only" keeps the enrollment's recipientEmail empty (meaning "the contact's primary at send time" - how
// every enrollment has always worked) and "All addresses" stores the validated, de-duplicated list in the same comma-separated recipientEmail that "both" has always used.
//
//   primary  - only the primary address (the default).
//   all      - every valid address on file, each exactly once. One email is sent to all of them together, so a reply from ANY of them is a reply to this enrollment.
//
// An address is never used when it is invalid, a duplicate, or on the company's do-not-email list: a marketing subscriber who UNSUBSCRIBED, or whose address is SUPPRESSED
// (bounce / complaint / invalid), is exactly what the existing consent and suppression rules say must not be emailed. Checked at enrollment AND again at send time, so
// someone who unsubscribes after being enrolled stops receiving the sequence at that address.

export type RecipientMode = "primary" | "all";
export const isRecipientMode = (value: unknown): value is RecipientMode => value === "primary" || value === "all";

type ContactEmails = { primaryEmail: string | null; emails: ReadonlyArray<{ email: string }> };

// Deliberately conservative: one @, no spaces / angle brackets / commas / quotes / control characters, a dot in the domain, within the SMTP length limit.
const ADDRESS = /^[^\s@<>,;"'()[\]\\\u0000-\u001f]+@[^\s@<>,;"'()[\]\\\u0000-\u001f]+\.[^\s@<>,;"'()[\]\\\u0000-\u001f]{2,}$/;

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidAddress(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && v.length <= 254 && v.split("@")[0].length <= 64 && ADDRESS.test(v);
}

/** The addresses to consider for a contact, in order (primary first), valid and de-duplicated (case-insensitively). Suppression is applied separately. */
export function candidateAddresses(contact: ContactEmails, mode: RecipientMode): string[] {
  const ordered = mode === "primary" ? [contact.primaryEmail] : [contact.primaryEmail, ...contact.emails.map((e) => e.email)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ordered) {
    if (!raw) continue;
    const address = normalizeAddress(raw);
    if (!isValidAddress(address) || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

/** Of these addresses, the ones this company must not email (unsubscribed or suppressed). */
export async function doNotEmail(companyId: string, addresses: readonly string[], db: Pick<typeof prisma, "subscriber"> = prisma): Promise<Set<string>> {
  const unique = [...new Set(addresses.map(normalizeAddress))];
  if (unique.length === 0) return new Set();
  const rows = await db.subscriber.findMany({ where: { companyId, email: { in: unique }, status: { in: ["UNSUBSCRIBED", "SUPPRESSED"] } }, select: { email: true } });
  return new Set(rows.map((r) => normalizeAddress(r.email)));
}

export type RecipientVerdict =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: "missingEmail" | "addressSuppressed" };

/** The pure decision, given what is on file and which addresses are blocked. */
export function chooseRecipients(contact: ContactEmails, mode: RecipientMode, blocked: ReadonlySet<string>): RecipientVerdict {
  const candidates = candidateAddresses(contact, mode);
  if (candidates.length === 0) return { ok: false, reason: "missingEmail" };
  const usable = candidates.filter((a) => !blocked.has(a));
  return usable.length === 0 ? { ok: false, reason: "addressSuppressed" } : { ok: true, addresses: usable };
}

/**
 * What the enrollment stores: nothing for "primary" (the primary is read at send time, as always); for "all", the comma-separated list of the usable addresses - unless that
 * list is exactly the contact's primary address, which needs no storing. (It used to store only when MORE THAN ONE address was usable, so a contact whose primary was unsubscribed,
 * suppressed or invalid but who had one other good address stored nothing - and the send-time rule then fell back to the unusable primary and failed the enrollment.)
 */
export function recipientToStore(mode: RecipientMode, addresses: readonly string[], primaryEmail?: string | null): string | undefined {
  if (mode !== "all" || addresses.length === 0) return undefined;
  const onlyThePrimary = addresses.length === 1 && !!primaryEmail && normalizeAddress(primaryEmail) === addresses[0];
  return onlyThePrimary ? undefined : addresses.join(", ");
}

/** The stored list, split into addresses (an enrollment's recipientEmail is comma-separated). */
export function splitStoredRecipients(stored: string): string[] {
  return stored.split(",").map(normalizeAddress).filter(Boolean);
}

/**
 * The To: for ONE send, decided at send time from what is stored: the explicit list (or the contact's primary), minus any address that has become unusable since. Returns
 * the address(es) to send to, or why there are none (the enrollment then fails visibly instead of sending to someone who asked not to be emailed).
 */
export async function resolveSendRecipients(
  enrollment: { recipientEmail: string | null },
  contact: { primaryEmail: string | null; companyId: string }
): Promise<{ ok: true; to: string } | { ok: false; reason: "missingEmail" | "addressSuppressed" }> {
  const stored = enrollment.recipientEmail ? splitStoredRecipients(enrollment.recipientEmail) : contact.primaryEmail ? [normalizeAddress(contact.primaryEmail)] : [];
  const valid = [...new Set(stored.filter(isValidAddress))];
  if (valid.length === 0) return { ok: false, reason: "missingEmail" };
  const blocked = await doNotEmail(contact.companyId, valid);
  const usable = valid.filter((a) => !blocked.has(a));
  return usable.length === 0 ? { ok: false, reason: "addressSuppressed" } : { ok: true, to: usable.join(", ") };
}
