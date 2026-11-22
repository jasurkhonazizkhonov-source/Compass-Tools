// Subscriber search by email, with the same privacy rule as the customer search (contact-search.ts):
//   * a COMPLETE address matches exactly (case-insensitive) for EVERY viewer - the searcher already holds the whole address, so finding the subscriber tells them
//     nothing they did not bring, and the result still shows the masked address when they may not see it;
//   * any other text (a fragment, a domain) matches only for a viewer who may see full addresses; for a restricted viewer it is an oracle that rebuilds a hidden
//     address piece by piece, so it matches NOTHING (an empty result, never "everything").
// One function builds the filter for the list, the count behind "select all matching" and the bulk delete, so those three can never disagree about which rows
// the search covers - the exact-delete safeguard depends on that.
import type { Prisma } from "@/generated/prisma/client";
import { cleanSearchQuery, isCompleteEmailAddress } from "@/server/search/contact-search";

export function subscriberSearchWhere(rawQuery: string | undefined, emailRestricted: boolean): Prisma.SubscriberWhereInput {
  const q = cleanSearchQuery(rawQuery ?? "");
  if (!q) return {};
  if (isCompleteEmailAddress(q)) return { email: { equals: q, mode: "insensitive" } };
  if (emailRestricted) return { id: { in: [] } }; // matches no row
  return { email: { contains: q, mode: "insensitive" } };
}
