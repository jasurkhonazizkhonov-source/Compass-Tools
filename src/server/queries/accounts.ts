import { prisma } from "@/lib/prisma";
import type { AccountRole } from "@/generated/prisma/client";
import { canManageAccounts } from "@/lib/permissions";
import { formatSignInLocation } from "@/server/auth/sign-in-context";

/**
 * Every field on every Account IN ONE COMPANY — the full, unfiltered
 * roster. Used by the admin-only /users management page, which must
 * continue to see and manage EVERY account regardless of its
 * accountsVisible preference (a hidden account is never deleted — it is only
 * left out of current-team views — so Admin user-management must never lose
 * sight of it). Do NOT
 * use this for the general-purpose /accounts directory — use
 * getAccountsDirectory below instead, which excludes hidden accounts at
 * the query level. Always scoped by companyId — an Admin/Manager must
 * never see another company's staff roster (see the Company model's
 * comment in schema.prisma).
 */
export async function getAllAccounts(companyId: string) {
  return prisma.account.findMany({ where: { companyId }, orderBy: { fullName: "asc" } });
}

export type AccountSignInDetails = {
  lastSignInAt: Date | null;
  /** The FULL address the latest successful sign-in came from. Administrator-only; never returned for any other role. */
  ip: string | null;
  /** "City, Region, Country" from the trusted proxy's geo headers (approximate); null when none was available. */
  location: string | null;
};

/**
 * Latest successful CRM sign-in per account (time, full IP, approximate location) for the Users page.
 *
 * Administrator-only AT THE QUERY: the viewer's role is checked here, so a caller that forgets to gate its page still gets
 * an empty map, never data. These columns are omitted from every other Prisma read (see the global omit in lib/prisma.ts)
 * and are opted into only below. Distinct from Account.location, which is the Admin-ASSIGNED work location.
 */
export async function getAccountSignInDetails(viewer: { role: AccountRole; companyId: string } | null | undefined): Promise<Map<string, AccountSignInDetails>> {
  const out = new Map<string, AccountSignInDetails>();
  if (!viewer || !canManageAccounts(viewer.role)) return out;
  const rows = await prisma.account.findMany({
    where: { companyId: viewer.companyId },
    select: { id: true, lastSignInAt: true, lastSignInIp: true, lastSignInCity: true, lastSignInRegion: true, lastSignInCountry: true, lastSignInCountryCode: true },
  });
  for (const r of rows) {
    out.set(r.id, {
      lastSignInAt: r.lastSignInAt,
      ip: r.lastSignInIp,
      location: formatSignInLocation({ city: r.lastSignInCity, region: r.lastSignInRegion, country: r.lastSignInCountry, countryCode: r.lastSignInCountryCode }),
    });
  }
  return out;
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
