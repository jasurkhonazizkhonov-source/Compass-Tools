import { prisma } from "@/lib/prisma";

/**
 * Every field on every Account IN ONE COMPANY — the full, unfiltered
 * roster. Used by the admin-only /users management page, which must
 * continue to see and manage EVERY account regardless of its
 * accountsVisible preference (Pass 11 Part 1 — "hidden from Accounts" is
 * only a /accounts-directory display preference, never a real deletion, so
 * Admin user-management must never lose sight of a hidden account). Do NOT
 * use this for the general-purpose /accounts directory — use
 * getAccountsDirectory below instead, which excludes hidden accounts at
 * the query level. Always scoped by companyId — an Admin/Manager must
 * never see another company's staff roster (see the Company model's
 * comment in schema.prisma).
 */
export async function getAllAccounts(companyId: string) {
  return prisma.account.findMany({ where: { companyId }, orderBy: { fullName: "asc" } });
}

/**
 * The general, read-only /accounts directory every authenticated CRM user
 * can see (Pass 11 Part 1). Excludes any account an Admin has hidden via
 * accountsVisible=false — enforced HERE, at the database query, not via
 * client-side/CSS filtering, so a hidden account's row is never present in
 * the page's data at all (search, the Online Only filter, and any future
 * filter on this page all inherit the exclusion for free, since they all
 * operate on this same already-filtered list). Same companyId scoping as
 * getAllAccounts.
 */
export async function getAccountsDirectory(companyId: string) {
  return prisma.account.findMany({ where: { companyId, accountsVisible: true }, orderBy: { fullName: "asc" } });
}
