import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// revealInquirySubmissionIp - the full IP a public inquiry came from is sensitive, so on top of the Admin-only inbox it uses the lead/booking IP
// gate: IP-reveal permission, a recent sign-in, a rate limit, an audit row that never contains the address, and a company + inbox scoped lookup.
// Only the database is faked; the real permission and step-up helpers run.

type FakeActor = { id: string; role: string; status: string; companyId: string; bookingPermissions: string[]; sessionCreatedAt: Date | null };
type FakeInfo = { inquiryId: string; companyId: string; source: string; ipAddress: string | null; ipVersion: string | null };
let currentActor: FakeActor | null;
let infos: Map<string, FakeInfo>;
let auditLogs: Array<{ actorId: string | undefined; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> }>;
let rate: { allowed: true } | { allowed: false; retryAfterSeconds: number };
let rateCalls: Array<{ id: string; endpoint: string }>;

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/server/security/rate-limit", () => ({
  checkAccountRateLimit: vi.fn(async (id: string, endpoint: string) => {
    rateCalls.push({ id, endpoint });
    return rate;
  }),
  RATE_LIMITS: { IP_REVEAL: { windowMs: 1, maxAttempts: 1 } },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async ({ data }: { data: (typeof auditLogs)[number] }) => {
        auditLogs.push(data);
        return data;
      }),
    },
    inquirySubmissionInfo: {
      findFirst: vi.fn(async ({ where }: { where: { inquiryId: string; inquiry: { companyId: string; source: string } } }) => {
        const row = infos.get(where.inquiryId);
        if (!row || row.companyId !== where.inquiry.companyId || row.source !== where.inquiry.source) return null;
        return { ipAddress: row.ipAddress, ipVersion: row.ipVersion };
      }),
    },
  },
}));

const IP = "203.0.113.42";
const fresh = () => new Date(Date.now() - 60_000);
const admin = (over: Partial<FakeActor> = {}): FakeActor => ({ id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "co", bookingPermissions: [], sessionCreatedAt: fresh(), ...over });

beforeEach(() => {
  auditLogs = [];
  rateCalls = [];
  rate = { allowed: true };
  currentActor = admin();
  infos = new Map([
    ["inq-crm", { inquiryId: "inq-crm", companyId: "co", source: "CRM_WEBSITE", ipAddress: IP, ipVersion: "v4" }],
    ["inq-bft", { inquiryId: "inq-bft", companyId: "co", source: "BUSINESS_FLIGHTS_WEBSITE", ipAddress: "2001:db8::7334", ipVersion: "v6" }],
    ["inq-other-co", { inquiryId: "inq-other-co", companyId: "other", source: "CRM_WEBSITE", ipAddress: IP, ipVersion: "v4" }],
    ["inq-noip", { inquiryId: "inq-noip", companyId: "co", source: "CRM_WEBSITE", ipAddress: null, ipVersion: null }],
  ]);
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe("revealInquirySubmissionIp", () => {
  it("an Admin with a fresh sign-in gets the full IP and version for either inbox; the audit rows never contain the address", async () => {
    const { revealInquirySubmissionIp } = await import("../inquiry-submission");
    expect(await revealInquirySubmissionIp("inq-crm", "CRM_WEBSITE")).toEqual({ ipAddress: IP, ipVersion: "v4" });
    expect(await revealInquirySubmissionIp("inq-bft", "BUSINESS_FLIGHTS_WEBSITE")).toEqual({ ipAddress: "2001:db8::7334", ipVersion: "v6" });
    expect(auditLogs.map((a) => a.action)).toEqual(["INQUIRY_IP_REVEALED", "INQUIRY_IP_REVEALED"]);
    expect(JSON.stringify(auditLogs)).not.toContain("203.0.113");
    expect(JSON.stringify(auditLogs)).not.toContain("2001:db8");
    expect(auditLogs[0]).toMatchObject({ actorId: "admin-1", entityType: "ContactInquiry", entityId: "inq-crm" });
  });

  it("every non-Admin role is refused and audited - Manager/Ticketing even WITH the booking reveal grant, because the inboxes are Admin-only", async () => {
    const { revealInquirySubmissionIp } = await import("../inquiry-submission");
    const roles = ["MANAGER", "TICKETING_AGENT", "TRAVEL_AGENT", "MARKETING_AGENT", "FLIGHT_EXPERT"];
    for (const role of roles) {
      currentActor = admin({ id: `u-${role}`, role, bookingPermissions: ["bookings.reveal_ip"] });
      await expect(revealInquirySubmissionIp("inq-crm", "CRM_WEBSITE"), role).rejects.toThrow(/not authorized/i);
    }
    expect(auditLogs).toHaveLength(roles.length);
    expect(auditLogs.every((a) => a.action === "INQUIRY_IP_REVEAL_DENIED" && a.metadata.reason === "MISSING_PERMISSION")).toBe(true);
  });

  it("IDOR: an inquiry of another company, or one asked for under the OTHER inbox's source, is indistinguishable from 'nothing captured'", async () => {
    const { revealInquirySubmissionIp } = await import("../inquiry-submission");
    await expect(revealInquirySubmissionIp("inq-other-co", "CRM_WEBSITE")).rejects.toThrow(/not authorized/i);
    await expect(revealInquirySubmissionIp("inq-crm", "BUSINESS_FLIGHTS_WEBSITE")).rejects.toThrow(/not authorized/i);
    await expect(revealInquirySubmissionIp("no-such-inquiry", "CRM_WEBSITE")).rejects.toThrow(/not authorized/i);
    expect(auditLogs.map((a) => a.metadata.reason)).toEqual(["NOT_ACCESSIBLE_OR_NOT_CAPTURED", "NOT_ACCESSIBLE_OR_NOT_CAPTURED", "NOT_ACCESSIBLE_OR_NOT_CAPTURED"]);
  });

  it("an invalid source or id is refused before any lookup", async () => {
    const { revealInquirySubmissionIp } = await import("../inquiry-submission");
    await expect(revealInquirySubmissionIp("inq-crm", "SOMETHING_ELSE" as never)).rejects.toThrow(/not authorized/i);
    await expect(revealInquirySubmissionIp("", "CRM_WEBSITE")).rejects.toThrow(/not authorized/i);
    await expect(revealInquirySubmissionIp("x".repeat(500), "CRM_WEBSITE")).rejects.toThrow(/not authorized/i);
    expect(auditLogs.every((a) => a.action === "INQUIRY_IP_REVEAL_DENIED" && a.metadata.reason === "INVALID_REQUEST")).toBe(true);
    expect(rateCalls).toEqual([]);
  });

  it("production: a stale sign-in returns an actionable message (no throw, no IP); a recent one succeeds", async () => {
    vi.stubEnv("APP_ENV", "production");
    const { revealInquirySubmissionIp } = await import("../inquiry-submission");
    currentActor = admin({ sessionCreatedAt: new Date(Date.now() - 30 * 60 * 1000) });
    const stale = await revealInquirySubmissionIp("inq-crm", "CRM_WEBSITE");
    expect(stale).toEqual({ error: expect.stringMatching(/sign-in within the last 15 minutes/) });
    expect(JSON.stringify(stale)).not.toContain(IP);
    expect(auditLogs.at(-1)).toMatchObject({ action: "INQUIRY_IP_REVEAL_DENIED", metadata: { reason: "RECENT_LOGIN_REQUIRED" } });
    currentActor = admin({ sessionCreatedAt: new Date(Date.now() - 60_000) });
    expect(await revealInquirySubmissionIp("inq-crm", "CRM_WEBSITE")).toMatchObject({ ipAddress: IP });
  });

  it("is rate limited per account, with a returned message, an audit row and no IP", async () => {
    const { revealInquirySubmissionIp } = await import("../inquiry-submission");
    await revealInquirySubmissionIp("inq-crm", "CRM_WEBSITE");
    expect(rateCalls).toEqual([{ id: "admin-1", endpoint: "IP_REVEAL" }]);
    rate = { allowed: false, retryAfterSeconds: 240 };
    const limited = await revealInquirySubmissionIp("inq-crm", "CRM_WEBSITE");
    expect(limited).toEqual({ error: expect.stringMatching(/Too many Reveal attempts.*4 minute/) });
    expect(auditLogs.at(-1)).toMatchObject({ action: "INQUIRY_IP_REVEAL_DENIED", metadata: { reason: "RATE_LIMITED" } });
  });

  it("no session / inactive account is refused; an inquiry with no IP recorded returns a plain message", async () => {
    const { revealInquirySubmissionIp } = await import("../inquiry-submission");
    currentActor = null;
    await expect(revealInquirySubmissionIp("inq-crm", "CRM_WEBSITE")).rejects.toThrow(/not authorized/i);
    currentActor = admin({ status: "INACTIVE" });
    await expect(revealInquirySubmissionIp("inq-crm", "CRM_WEBSITE")).rejects.toThrow(/not authorized/i);
    currentActor = admin();
    expect(await revealInquirySubmissionIp("inq-noip", "CRM_WEBSITE")).toEqual({ error: "No IP address was recorded for this submission." });
  });
});
