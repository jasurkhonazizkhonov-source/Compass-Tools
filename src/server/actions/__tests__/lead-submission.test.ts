import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// revealLeadSubmissionIp — the full IP a lead was submitted from is sensitive, so it uses the booking
// signer IP's gate: IP-reveal permission, the lead's own visibility, a recent sign-in, a rate limit and
// an audit row that never contains the address. Real leadVisibilityWhere; only the DB is faked.

type FakeActor = { id: string; role: string; status: string; companyId: string; bookingPermissions: string[]; sessionCreatedAt: Date | null };
type FakeInfo = { leadId: string; ipAddress: string | null; ipVersion: string | null; assignedAgentId: string | null; agentManagerId: string | null };
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
    leadSubmissionInfo: {
      // Interprets the exact where shape leadVisibilityWhere() produces for each role.
      findFirst: vi.fn(async ({ where }: { where: { leadId: string; lead: Record<string, unknown> } }) => {
        const row = infos.get(where.leadId);
        if (!row) return null;
        const lead = where.lead as { assignedAgentId?: string; OR?: Array<Record<string, unknown>> };
        if (lead.assignedAgentId !== undefined && row.assignedAgentId !== lead.assignedAgentId) return null; // restricted role: own lead only
        if (lead.OR) {
          const ok = lead.OR.some((c) => {
            if (typeof c.assignedAgentId === "string") return row.assignedAgentId === c.assignedAgentId;
            const team = (c.assignedAgent as { is?: { managerId: string; role: string } } | undefined)?.is;
            return !!team && row.agentManagerId === team.managerId;
          });
          if (!ok) return null;
        }
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
    ["lead-team", { leadId: "lead-team", ipAddress: IP, ipVersion: "v4", assignedAgentId: "agent-A", agentManagerId: "mgr-1" }],
    ["lead-other", { leadId: "lead-other", ipAddress: IP, ipVersion: "v4", assignedAgentId: "agent-B", agentManagerId: "mgr-2" }],
    ["lead-v6", { leadId: "lead-v6", ipAddress: "2001:db8::7334", ipVersion: "v6", assignedAgentId: "agent-A", agentManagerId: "mgr-1" }],
    ["lead-noip", { leadId: "lead-noip", ipAddress: null, ipVersion: null, assignedAgentId: "agent-A", agentManagerId: "mgr-1" }],
  ]);
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe("revealLeadSubmissionIp", () => {
  it("Admin with a fresh sign-in gets the full IP and its version; the audit row records the reveal WITHOUT the address", async () => {
    const { revealLeadSubmissionIp } = await import("../lead-submission");
    expect(await revealLeadSubmissionIp("lead-team")).toEqual({ ipAddress: IP, ipVersion: "v4" });
    expect(await revealLeadSubmissionIp("lead-v6")).toEqual({ ipAddress: "2001:db8::7334", ipVersion: "v6" });
    expect(auditLogs.map((a) => a.action)).toEqual(["LEAD_IP_REVEALED", "LEAD_IP_REVEALED"]);
    expect(JSON.stringify(auditLogs)).not.toContain("203.0.113");
    expect(JSON.stringify(auditLogs)).not.toContain("2001:db8");
    expect(auditLogs[0]).toMatchObject({ actorId: "admin-1", entityType: "Lead", entityId: "lead-team" });
  });

  it("role gate: a Travel Agent (even on their own lead), a Marketing Agent, a Flight Expert and a Manager/Ticketing WITHOUT the grant are refused and audited", async () => {
    const { revealLeadSubmissionIp } = await import("../lead-submission");
    const cases: Array<[string, Partial<FakeActor>]> = [
      ["TRAVEL_AGENT own lead", { id: "agent-A", role: "TRAVEL_AGENT", bookingPermissions: ["bookings.reveal_ip"] }],
      ["MARKETING_AGENT", { id: "m", role: "MARKETING_AGENT", bookingPermissions: ["bookings.reveal_ip"] }],
      ["FLIGHT_EXPERT", { id: "f", role: "FLIGHT_EXPERT", bookingPermissions: ["bookings.reveal_ip"] }],
      ["MANAGER no grant", { id: "mgr-1", role: "MANAGER", bookingPermissions: [] }],
    ];
    for (const [label, over] of cases) {
      currentActor = admin(over);
      await expect(revealLeadSubmissionIp("lead-team"), label).rejects.toThrow(/not authorized/i);
    }
    expect(auditLogs).toHaveLength(cases.length);
    expect(auditLogs.every((a) => a.action === "LEAD_IP_REVEAL_DENIED" && a.metadata.reason === "MISSING_PERMISSION")).toBe(true);
  });

  it("a Manager WITH the grant reaches only their own team's leads — another team's lead is indistinguishable from 'nothing captured' (IDOR)", async () => {
    const { revealLeadSubmissionIp } = await import("../lead-submission");
    currentActor = admin({ id: "mgr-1", role: "MANAGER", bookingPermissions: ["bookings.reveal_ip"] });
    expect(await revealLeadSubmissionIp("lead-team")).toMatchObject({ ipAddress: IP });
    await expect(revealLeadSubmissionIp("lead-other")).rejects.toThrow(/not authorized/i);
    await expect(revealLeadSubmissionIp("no-such-lead")).rejects.toThrow(/not authorized/i);
    expect(auditLogs.filter((a) => a.action === "LEAD_IP_REVEAL_DENIED").map((a) => a.metadata.reason)).toEqual(["NOT_ACCESSIBLE_OR_NOT_CAPTURED", "NOT_ACCESSIBLE_OR_NOT_CAPTURED"]);
  });

  it("production: a stale sign-in returns an actionable message (no throw, no IP), a recent one succeeds", async () => {
    vi.stubEnv("APP_ENV", "production");
    const { revealLeadSubmissionIp } = await import("../lead-submission");
    currentActor = admin({ sessionCreatedAt: new Date(Date.now() - 30 * 60 * 1000) });
    const stale = await revealLeadSubmissionIp("lead-team");
    expect(stale).toEqual({ error: expect.stringMatching(/sign-in within the last 15 minutes/) });
    expect(JSON.stringify(stale)).not.toContain(IP);
    expect(auditLogs.at(-1)).toMatchObject({ action: "LEAD_IP_REVEAL_DENIED", metadata: { reason: "RECENT_LOGIN_REQUIRED" } });
    currentActor = admin({ sessionCreatedAt: new Date(Date.now() - 60_000) });
    expect(await revealLeadSubmissionIp("lead-team")).toMatchObject({ ipAddress: IP });
  });

  it("is rate limited per account: the limiter is consulted for every attempt, and a limited account gets a returned message, an audit row and no IP", async () => {
    const { revealLeadSubmissionIp } = await import("../lead-submission");
    await revealLeadSubmissionIp("lead-team");
    expect(rateCalls).toEqual([{ id: "admin-1", endpoint: "IP_REVEAL" }]);
    rate = { allowed: false, retryAfterSeconds: 240 };
    const limited = await revealLeadSubmissionIp("lead-team");
    expect(limited).toEqual({ error: expect.stringMatching(/Too many Reveal attempts.*4 minute/) });
    expect(auditLogs.at(-1)).toMatchObject({ action: "LEAD_IP_REVEAL_DENIED", metadata: { reason: "RATE_LIMITED" } });
  });

  it("no session / inactive account is refused; a lead with no IP recorded returns a plain message", async () => {
    const { revealLeadSubmissionIp } = await import("../lead-submission");
    currentActor = null;
    await expect(revealLeadSubmissionIp("lead-team")).rejects.toThrow(/not authorized/i);
    currentActor = admin({ status: "INACTIVE" });
    await expect(revealLeadSubmissionIp("lead-team")).rejects.toThrow(/not authorized/i);
    currentActor = admin();
    expect(await revealLeadSubmissionIp("lead-noip")).toEqual({ error: "No IP address was recorded for this submission." });
  });
});
