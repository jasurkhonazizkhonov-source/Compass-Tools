// One definition of "which contacts does this search text match", shared by the global search, the Contacts and Leads lists and the task-link search, so that
// they cannot drift apart again. It only builds a Prisma filter: the caller always ANDs it with the viewer's visibility filter (contactVisibilityWhere,
// leadVisibilityWhere, quoteVisibilityWhere), so a search can never reach a record the viewer may not open.
//
// What matches
//   * Name: every space-separated word of the text must match the first, middle or last name (partial, case-insensitive) - "ada", "love", "Ada Lovelace",
//     "lovelace ada" all find Ada Lovelace.
//   * Phone: a text made only of phone characters is compared by its digits against the stored E.164 numbers (primary and every other number of the contact), so
//     "(415) 555-0123", "415 555 0123", "+1 415 555 0123", "1-415-555-0123" and "00 1 415 555 0123" all find +14155550123. At least 5 digits, at most 15.
//   * Email - this is where the viewer's privacy matters:
//       - a COMPLETE address (local@domain.tld) matches exactly (case-insensitive, surrounding spaces/<>/mailto: ignored) against the primary AND every other
//         address of the contact, for EVERY viewer, restricted or not. The searcher already holds the whole address, so the match tells them nothing they did
//         not bring with them; they still see the MASKED address in the result unless they may see it (that is decided by the callers' email-privacy layer).
//       - any other email text (a fragment, a domain) matches only for a viewer who may see full addresses. For a restricted viewer a fragment match would be an
//         oracle that reconstructs a hidden address one piece at a time, so it is never offered.
//
// The search text itself is never logged by this module; it only returns a filter.
import type { Prisma } from "@/generated/prisma/client";

const MAX_WORDS = 5;
const MAX_QUERY_LENGTH = 200;
// Deliberately conservative: a complete, ordinary address. Anything that does not pass is treated as a fragment.
const FULL_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function cleanSearchQuery(raw: string): string {
  let q = raw.normalize("NFKC").replace(/[\s ]+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  q = q.replace(/^mailto:/i, "");
  if (q.startsWith("<") && q.endsWith(">")) q = q.slice(1, -1).trim();
  return q;
}

export function isCompleteEmailAddress(q: string): boolean {
  return q.length <= 254 && FULL_EMAIL.test(q);
}

/** The digit strings a phone-looking search text should be looked for in the stored numbers, or [] when the text is not a phone number. */
export function phoneSearchNeedles(q: string): string[] {
  if (!/^\+?[\d\s().\-]+$/.test(q)) return [];
  let digits = q.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2); // international call prefix
  if (digits.length < 5 || digits.length > 15) return [];
  const withoutTrunk = digits.replace(/^0+/, ""); // national trunk zero: 0415 555 012 is stored as +61415555012
  return [...new Set([digits, ...(withoutTrunk.length >= 5 ? [withoutTrunk] : [])])];
}

export function nameSearchCondition(q: string): Prisma.ContactWhereInput | null {
  const words = q.split(" ").filter(Boolean).slice(0, MAX_WORDS);
  if (words.length === 0) return null;
  return {
    AND: words.map((w) => ({
      OR: [
        { firstName: { contains: w, mode: "insensitive" as const } },
        { middleName: { contains: w, mode: "insensitive" as const } },
        { lastName: { contains: w, mode: "insensitive" as const } },
      ],
    })),
  };
}

/** The OR-list of conditions on a Contact for this search text. Empty when the text is blank. */
export function contactSearchConditions(rawQuery: string, options: { emailRestricted: boolean }): Prisma.ContactWhereInput[] {
  const q = cleanSearchQuery(rawQuery);
  if (!q) return [];
  const out: Prisma.ContactWhereInput[] = [];

  const name = nameSearchCondition(q);
  if (name) out.push(name);

  for (const needle of phoneSearchNeedles(q)) {
    out.push({ primaryPhone: { contains: needle } }, { phones: { some: { number: { contains: needle } } } });
  }
  // The text exactly as typed, for stored numbers that carry formatting (older data) - still only a phone-looking text.
  if (phoneSearchNeedles(q).length > 0) out.push({ primaryPhone: { contains: q } });

  if (isCompleteEmailAddress(q)) {
    out.push({ primaryEmail: { equals: q, mode: "insensitive" } }, { emails: { some: { email: { equals: q, mode: "insensitive" } } } });
    if (!options.emailRestricted) out.push({ primaryEmail: { contains: q, mode: "insensitive" } });
  } else if (!options.emailRestricted) {
    out.push({ primaryEmail: { contains: q, mode: "insensitive" } }, { emails: { some: { email: { contains: q, mode: "insensitive" } } } });
  }
  return out;
}

/** The same conditions for a model that points at the contact through a `contact` relation (Lead, Quote, Booking). */
export function viaContact(conditions: Prisma.ContactWhereInput[]): Array<{ contact: Prisma.ContactWhereInput }> {
  return conditions.map((c) => ({ contact: c }));
}
