import { prisma } from "@/lib/prisma";
import { canViewGetInTouch } from "@/lib/permissions";
import { maskIp } from "@/server/security/ip-encryption";
import type { AccountRole, InquirySource } from "@/generated/prisma/client";

/**
 * The "Submission & IP Information" of ONE public inquiry (Business Flights "Get In Touch" or "CRM Inquiries") - never part of an ordinary inquiry
 * query or list (getContactInquiryDetail does not select it), so the IP can only reach a screen through this path.
 *
 * Admin-only, exactly like the inboxes themselves (canViewGetInTouch). The full address is sensitive personal data and is NEVER returned here:
 * the page gets only the masked form (e.g. "203.x.x.x") and whether an address exists; the whole address is available only through the audited,
 * permission-gated, recent-sign-in Reveal in actions/inquiry-submission.ts. The lookup is scoped by company AND source in the database, so an id
 * from the other inbox (or another company) yields nothing. Returns null for "no access" and "nothing was captured" alike.
 */
export async function getInquirySubmissionInfo(inquiryId: string, companyId: string, source: InquirySource, role: AccountRole | undefined) {
  if (!canViewGetInTouch(role)) return null;
  const row = await prisma.inquirySubmissionInfo.findFirst({
    where: { inquiryId, inquiry: { companyId, source } },
    select: { ipAddress: true, ipVersion: true, city: true, region: true, country: true, countryCode: true, timeZone: true, geoSource: true, capturedAt: true },
  });
  if (!row) return null;
  const { ipAddress, ipVersion, ...rest } = row;
  const version: "v4" | "v6" | null = ipAddress ? (ipVersion === "v6" || ipAddress.includes(":") ? "v6" : "v4") : null;
  return { ...rest, hasIp: !!ipAddress, ipVersion: version, ipMasked: ipAddress && version ? maskIp(ipAddress, version) : null };
}
