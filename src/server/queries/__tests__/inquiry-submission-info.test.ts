import { describe, it, expect, vi, beforeEach } from "vitest";

// The inquiry's submission info reaches a screen only through this query: Admin-only, company + inbox scoped in the database, and NEVER the full IP.

type Row = { ipAddress: string | null; ipVersion: string | null; city: string | null; region: string | null; country: string | null; countryCode: string | null; timeZone: string | null; geoSource: string | null; capturedAt: Date };
let row: Row | null;
const findFirst = vi.fn<(a: unknown) => Promise<Row | null>>(async () => row);
vi.mock("@/lib/prisma", () => ({ prisma: { inquirySubmissionInfo: { findFirst: (a: unknown) => findFirst(a) } } }));

const base: Row = { ipAddress: "203.0.113.42", ipVersion: "v4", city: "Sydney", region: "New South Wales", country: "Australia", countryCode: "AU", timeZone: "Australia/Sydney", geoSource: "DBIP-City-Lite (2026-11-01)", capturedAt: new Date() };

beforeEach(() => {
  row = { ...base };
  findFirst.mockClear();
});

describe("getInquirySubmissionInfo", () => {
  it("returns the masked IP and the approximate location for an Admin - never the full address", async () => {
    const { getInquirySubmissionInfo } = await import("../inquiry-submission-info");
    const r = await getInquirySubmissionInfo("inq-1", "co", "CRM_WEBSITE", "ADMIN");
    expect(r).toMatchObject({ hasIp: true, ipVersion: "v4", ipMasked: "203.x.x.x", city: "Sydney", countryCode: "AU", timeZone: "Australia/Sydney" });
    expect(JSON.stringify(r)).not.toContain("203.0.113.42");
    expect(r).not.toHaveProperty("ipAddress");
  });

  it("masks IPv6 too, and reports 'no IP' honestly for a row that only has a location", async () => {
    const { getInquirySubmissionInfo } = await import("../inquiry-submission-info");
    row = { ...base, ipAddress: "2001:db8:85a3::8a2e:370:7334", ipVersion: "v6" };
    const v6 = await getInquirySubmissionInfo("inq-1", "co", "CRM_WEBSITE", "ADMIN");
    expect(v6).toMatchObject({ hasIp: true, ipVersion: "v6" });
    expect(JSON.stringify(v6)).not.toContain("8a2e");
    row = { ...base, ipAddress: null, ipVersion: null };
    expect(await getInquirySubmissionInfo("inq-1", "co", "CRM_WEBSITE", "ADMIN")).toMatchObject({ hasIp: false, ipMasked: null, ipVersion: null });
  });

  it("every non-Admin role (and no role) gets null WITHOUT touching the database", async () => {
    const { getInquirySubmissionInfo } = await import("../inquiry-submission-info");
    for (const role of ["MANAGER", "TICKETING_AGENT", "TRAVEL_AGENT", "MARKETING_AGENT", "FLIGHT_EXPERT", undefined] as const) {
      expect(await getInquirySubmissionInfo("inq-1", "co", "CRM_WEBSITE", role as never), String(role)).toBeNull();
    }
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("scopes the lookup by company AND inbox in the database, so another inbox's or company's id yields nothing", async () => {
    const { getInquirySubmissionInfo } = await import("../inquiry-submission-info");
    await getInquirySubmissionInfo("inq-1", "co", "BUSINESS_FLIGHTS_WEBSITE", "ADMIN");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { inquiryId: "inq-1", inquiry: { companyId: "co", source: "BUSINESS_FLIGHTS_WEBSITE" } } }));
    row = null;
    expect(await getInquirySubmissionInfo("inq-1", "co", "CRM_WEBSITE", "ADMIN")).toBeNull();
  });
});
