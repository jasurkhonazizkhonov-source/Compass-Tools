import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Same in-memory-fake convention as booking-security.test.ts — real
// bookingVisibilityWhere() output is interpreted by the fake, so IDOR
// tests exercise real authorization logic, not a re-implementation of it.
//
// This file previously also covered the standalone "IP Vault" cross-
// booking search/export/bulk-flag feature (searchIpVault,
// exportIpVaultSearchCsv, setIpCaptureSuspicious, setIpCaptureNote,
// getIpVaultStats). That feature and its tests were removed along with
// the /ip-vault page. What remains here covers getIpHistoryForBooking and
// getBookingIpMaskedPreview — the subset ip-vault.ts still exports for the
// per-booking "Submission IP" UI (BookingIpReveal).

const ENCRYPTION_KEY = "YgfNgrkVYRowXtQi3KJgD2vQOgze0r12K6kTBWUQTQI=";
const HASH_KEY = "oYQZyGTNHuPCyHRql2/SVOgH3IJHTeGSchk4rLRMjzg=";

type FakeAccount = { id: string; role: string; status: string; companyId: string; bookingPermissions: string[] };
type FakeBooking = { id: string; companyId: string; quoteAgentId?: string; leadAssignedAgentId?: string; contactOwnerId?: string };
type FakeCapture = {
  id: string;
  encryptedIp: string;
  ipHash: string;
  subnetHash: string;
  ipVersion: string;
  formType: string;
  bookingId: string | null;
  signerName: string | null;
  signerEmail: string | null;
  userAgent: string | null;
  capturedAt: Date;
  riskScore: number;
  suspicious: boolean;
  notes: string | null;
  softDeletedAt: Date | null;
};

let currentActor: FakeAccount | null;
let bookings: Map<string, FakeBooking>;
let captures: FakeCapture[];
let auditLogs: Array<{ actorId: string | undefined; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> }>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

function bookingMatchesVisibility(booking: FakeBooking, where: Record<string, unknown>): boolean {
  const contactCond = (where as { contact?: { companyId?: string } }).contact;
  if (contactCond?.companyId) return booking.companyId === contactCond.companyId;
  const or = (where as { OR?: Array<Record<string, Record<string, string>>> }).OR;
  if (or) {
    return or.some((cond) => {
      if (cond.quote?.agentId) return booking.quoteAgentId === cond.quote.agentId;
      if (cond.lead?.assignedAgentId) return booking.leadAssignedAgentId === cond.lead.assignedAgentId;
      if (cond.contact?.ownerId) return booking.contactOwnerId === cond.contact.ownerId;
      return false;
    });
  }
  return false;
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async ({ data }: { data: (typeof auditLogs)[number] }) => {
        auditLogs.push(data);
        return data;
      }),
      count: vi.fn(async ({ where }: { where: { actorId: string; createdAt: { gte: Date } } }) => {
        return auditLogs.filter((l) => l.actorId === where.actorId).length;
      }),
    },
    booking: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = bookings.get(where.id as string);
        if (!row) return null;
        if (!bookingMatchesVisibility(row, where)) return null;
        return { id: row.id };
      }),
    },
    ipCapture: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return filterCaptures(where);
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return filterCaptures(where).length;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return filterCaptures(where)[0] ?? null;
      }),
    },
  },
}));

function filterCaptures(where: Record<string, unknown>): FakeCapture[] {
  let rows = captures.slice();
  if (where.softDeletedAt === null) rows = rows.filter((c) => c.softDeletedAt === null);
  if (where.formType) rows = rows.filter((c) => c.formType === where.formType);
  if (where.bookingId && typeof where.bookingId === "string") rows = rows.filter((c) => c.bookingId === where.bookingId);
  return rows;
}

beforeEach(() => {
  vi.stubEnv("IP_ENCRYPTION_KEY", ENCRYPTION_KEY);
  vi.stubEnv("IP_HASH_KEY", HASH_KEY);
  bookings = new Map();
  captures = [];
  auditLogs = [];
  currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "company-1", bookingPermissions: ["bookings.reveal_ip"] };
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("IP_ENCRYPTION_KEY", ENCRYPTION_KEY);
  vi.stubEnv("IP_HASH_KEY", HASH_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedCapture(overrides: Partial<FakeCapture> = {}) {
  const { encryptIp, hashIpForSearch, hashSubnetForSearch } = await import("../../security/ip-encryption");
  const ip = (overrides as { plainIp?: string }).plainIp ?? "203.0.113.42";
  bookings.set("booking-1", { id: "booking-1", companyId: "company-1" });
  captures.push({
    id: "capture-1",
    encryptedIp: encryptIp(ip),
    ipHash: hashIpForSearch(ip),
    subnetHash: hashSubnetForSearch(ip, "v4"),
    ipVersion: "v4",
    formType: "NEW_BOOKING",
    bookingId: "booking-1",
    signerName: "Jane Doe",
    signerEmail: "jane@example.com",
    userAgent: null,
    capturedAt: new Date(),
    riskScore: 0,
    suspicious: false,
    notes: null,
    softDeletedAt: null,
    ...overrides,
  });
}

describe("getIpHistoryForBooking", () => {
  it("returns every capture for a booking, not just the latest", async () => {
    await seedCapture({ id: "capture-1", formType: "NEW_BOOKING", capturedAt: new Date("2026-01-01") });
    await seedCapture({ id: "capture-2", formType: "CANCELLATION_CONFIRMATION", capturedAt: new Date("2026-02-01") });
    const { getIpHistoryForBooking } = await import("../ip-vault");
    const history = await getIpHistoryForBooking("booking-1");
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.formType)).toEqual(["NEW_BOOKING", "CANCELLATION_CONFIRMATION"]);
  });

  it("denies access to a booking outside the actor's visibility scope", async () => {
    await seedCapture();
    bookings.set("booking-1", { id: "booking-1", companyId: "company-1", quoteAgentId: "someone-else", leadAssignedAgentId: "someone-else", contactOwnerId: "someone-else" });
    currentActor = { id: "actor-1", role: "TICKETING_AGENT", status: "ACTIVE", companyId: "other-company", bookingPermissions: ["bookings.reveal_ip"] };
    const { getIpHistoryForBooking } = await import("../ip-vault");
    await expect(getIpHistoryForBooking("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a role without canRevealBookingIp", async () => {
    await seedCapture();
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1", bookingPermissions: [] };
    const { getIpHistoryForBooking } = await import("../ip-vault");
    await expect(getIpHistoryForBooking("booking-1")).rejects.toThrow(/not authorized/i);
  });
});

describe("getBookingIpMaskedPreview — non-privileged masked view", () => {
  it("returns a masked preview for a role without canRevealBookingIp, as long as it can see the booking at all", async () => {
    await seedCapture();
    // TRAVEL_AGENT has no company-wide visibility (unlike ADMIN/MANAGER/
    // TICKETING_AGENT/FLIGHT_EXPERT) — bookingVisibilityWhere only grants
    // it row-level access via direct ownership, so the fake booking must
    // actually be owned by this actor for "can see the booking" to hold.
    bookings.set("booking-1", { id: "booking-1", companyId: "company-1", contactOwnerId: "agent-1" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1", bookingPermissions: [] };
    const { getBookingIpMaskedPreview } = await import("../ip-vault");
    const preview = await getBookingIpMaskedPreview("booking-1");
    expect(preview).not.toBeNull();
    expect(preview?.masked).toBe("203.x.x.x");
    expect(preview?.masked).not.toContain("113.42");
    expect(preview?.ipVersion).toBe("v4");
  });

  it("returns null for a role that cannot see the booking at all (no ownership relation)", async () => {
    await seedCapture();
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1", bookingPermissions: [] };
    const { getBookingIpMaskedPreview } = await import("../ip-vault");
    const preview = await getBookingIpMaskedPreview("booking-1");
    expect(preview).toBeNull();
  });

  it("returns a non-null preview WITH an explanatory reason (not a bare null) when nothing has been captured for a booking the actor can see — a real 'why is this missing' explanation instead of the previous ambiguous null", async () => {
    bookings.set("booking-1", { id: "booking-1", companyId: "company-1", contactOwnerId: "agent-1" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1", bookingPermissions: [] };
    const { getBookingIpMaskedPreview } = await import("../ip-vault");
    const preview = await getBookingIpMaskedPreview("booking-1");
    expect(preview).not.toBeNull();
    expect(preview?.masked).toBeNull();
    expect(preview?.count).toBe(0);
    expect(typeof preview?.reason).toBe("string");
    expect(preview?.reason).toMatch(/trusted reverse proxy|no ip address was captured/i);
  });

  it("still returns null (not a fabricated reason) for a booking the actor cannot see at all", async () => {
    bookings.set("booking-1", { id: "booking-1", companyId: "company-1" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1", bookingPermissions: [] };
    const { getBookingIpMaskedPreview } = await import("../ip-vault");
    const preview = await getBookingIpMaskedPreview("booking-1");
    expect(preview).toBeNull();
  });

  it("returns null (never throws) for an unauthenticated viewer", async () => {
    await seedCapture();
    currentActor = null;
    const { getBookingIpMaskedPreview } = await import("../ip-vault");
    await expect(getBookingIpMaskedPreview("booking-1")).resolves.toBeNull();
  });
});
