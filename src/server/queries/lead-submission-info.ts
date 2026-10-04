import { prisma } from "@/lib/prisma";
import { canViewLeadSubmissionInfo } from "@/lib/permissions";
import { leadVisibilityWhere, type Viewer } from "@/server/visibility";

/**
 * The "Lead Submission Information" of ONE lead — never part of an ordinary
 * lead query or list, so the IP can only reach a screen through this path.
 *
 * Authorisation is the lead's own: the lead must be inside the viewer's
 * leadVisibilityWhere (a Travel Agent's own leads, a Manager's own + team's,
 * company-wide for Admin/Ticketing), evaluated by the database against the
 * requested id, so changing an id in a URL or argument yields nothing — and the
 * role must be one that has the Leads area at all. Returns null for "no access"
 * and for "nothing was captured" alike (the caller cannot tell them apart).
 */
export async function getLeadSubmissionInfo(leadId: string, viewer: Viewer) {
  if (!viewer || !canViewLeadSubmissionInfo(viewer.role)) return null;
  return prisma.leadSubmissionInfo.findFirst({
    where: { leadId, lead: leadVisibilityWhere(viewer) },
    select: { ipAddress: true, ipVersion: true, city: true, region: true, country: true, countryCode: true, timeZone: true, geoSource: true, budgetCurrency: true, capturedAt: true },
  });
}
