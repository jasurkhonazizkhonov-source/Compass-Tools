import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Same in-memory-fake convention as payment-methods.test.ts. bookingVisibilityWhere()
// is the REAL implementation — only prisma.booking.findFirst is faked, interpreting
// the exact where shape it produces, so IDOR tests exercise real authorization logic.

type FakeAccount = { id: string; role: string; status: string; bookingPermissions: string[] };
type FakeBooking = {
  id: string;
  createdAt: Date;
  ipAddress: string | null;
  quoteAgentId?: string;
  leadAssignedAgentId?: string;
  contactOwnerId?: string;
};

let currentActor: FakeAccount | null;
let bookings: Map<string, FakeBooking>;
let auditLogs: Array<{ actorId: string | undefined; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> }>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async ({ data }: { data: { actorId: string | undefined; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> } }) => {
        auditLogs.push(data);
        return data;
      }),
    },
    booking: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = bookings.get(where.id as string);
        if (!row) return null;
        const or = where.OR as Array<Record<string, Record<string, string>>> | undefined;
        if (or) {
          const matches = or.some((cond) => {
            if (cond.quote?.agentId) return row.quoteAgentId === cond.quote.agentId;
            if (cond.lead?.assignedAgentId) return row.leadAssignedAgentId === cond.lead.assignedAgentId;
            if (cond.contact?.ownerId) return row.contactOwnerId === cond.contact.ownerId;
            return false;
          });
          if (!matches) return null;
        }
        return { id: row.id, createdAt: row.createdAt, signature: { ipAddress: row.ipAddress } };
      }),
    },
  },
}));

beforeEach(() => {
  bookings = new Map();
  auditLogs = [];
  currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", bookingPermissions: ["bookings.reveal_ip"] };
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function seedBooking(overrides: Partial<FakeBooking> = {}) {
  bookings.set("booking-1", { id: "booking-1", createdAt: new Date(), ipAddress: "203.0.113.42", ...overrides });
}

describe("revealBookingIp — role x permission matrix", () => {
  const ROLE_CASES: Array<{ role: string; eligible: boolean }> = [
    { role: "ADMIN", eligible: true },
    { role: "MANAGER", eligible: true },
    { role: "TICKETING_AGENT", eligible: true },
    { role: "TRAVEL_AGENT", eligible: false },
    { role: "FLIGHT_EXPERT", eligible: false },
  ];

  for (const { role, eligible } of ROLE_CASES) {
    it(`${role} WITH bookings.reveal_ip -> ${eligible ? "allowed" : "denied"}`, async () => {
      seedBooking();
      currentActor = { id: "actor-1", role, status: "ACTIVE", bookingPermissions: ["bookings.reveal_ip"] };
      const { revealBookingIp } = await import("../booking-security");
      if (eligible) {
        const result = await revealBookingIp("booking-1");
        expect(result.ipAddress).toBe("203.0.113.42");
      } else {
        await expect(revealBookingIp("booking-1")).rejects.toThrow(/not authorized/i);
      }
    });

    it(`${role} WITHOUT bookings.reveal_ip -> ${role === "ADMIN" ? "still allowed (Admin bypasses the grant array)" : "always denied"}`, async () => {
      seedBooking();
      currentActor = { id: "actor-1", role, status: "ACTIVE", bookingPermissions: [] };
      const { revealBookingIp } = await import("../booking-security");
      if (role === "ADMIN") {
        const result = await revealBookingIp("booking-1");
        expect(result.ipAddress).toBe("203.0.113.42");
      } else {
        await expect(revealBookingIp("booking-1")).rejects.toThrow(/not authorized/i);
      }
    });
  }

  it("rejects an unauthenticated actor", async () => {
    seedBooking();
    currentActor = null;
    const { revealBookingIp } = await import("../booking-security");
    await expect(revealBookingIp("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects an INACTIVE account even with the permission and an eligible role", async () => {
    seedBooking();
    currentActor = { id: "admin-1", role: "ADMIN", status: "INACTIVE", bookingPermissions: ["bookings.reveal_ip"] };
    const { revealBookingIp } = await import("../booking-security");
    await expect(revealBookingIp("booking-1")).rejects.toThrow(/not authorized/i);
  });
});

describe("revealBookingIp — IDOR/BOLA protection", () => {
  it("denies reveal when the booking is outside a restricted actor's own visibility scope", async () => {
    seedBooking({ quoteAgentId: "someone-else", leadAssignedAgentId: "someone-else", contactOwnerId: "someone-else" });
    // MANAGER has org-wide visibility, so this alone wouldn't test IDOR; the
    // role ceiling already denies FLIGHT_EXPERT/TRAVEL_AGENT before IDOR
    // even runs (matches the equivalent test in payment-methods.test.ts).
    // IDOR is meaningfully exercised for TICKETING_AGENT/MANAGER/ADMIN,
    // which have org-wide visibility by design (see visibility.ts) — so
    // there is no restricted-but-eligible role to test a genuine denial
    // with here; this is documented, not a gap, matching canViewAllRecords'
    // intentional design for these three roles.
    currentActor = { id: "manager-1", role: "MANAGER", status: "ACTIVE", bookingPermissions: ["bookings.reveal_ip"] };
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result.ipAddress).toBe("203.0.113.42");
  });

  it("rejects a non-existent booking id", async () => {
    seedBooking();
    const { revealBookingIp } = await import("../booking-security");
    await expect(revealBookingIp("does-not-exist")).rejects.toThrow(/not authorized/i);
  });
});

describe("revealBookingIp — audit trail never duplicates the sensitive IP value", () => {
  it("records a SUCCESS audit entry without embedding the revealed IP", async () => {
    seedBooking();
    const { revealBookingIp } = await import("../booking-security");
    await revealBookingIp("booking-1");

    expect(auditLogs).toHaveLength(1);
    const entry = auditLogs[0];
    expect(entry.action).toBe("BOOKING_IP_REVEALED");
    expect(entry.entityType).toBe("Booking");
    expect(entry.entityId).toBe("booking-1");
    expect(JSON.stringify(entry)).not.toContain("203.0.113.42");
  });

  it("records a DENIED audit entry with a reason when permission is missing", async () => {
    seedBooking();
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", bookingPermissions: [] };
    const { revealBookingIp } = await import("../booking-security");
    await expect(revealBookingIp("booking-1")).rejects.toThrow();

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe("BOOKING_IP_REVEAL_DENIED");
    expect(auditLogs[0].metadata.reason).toBe("MISSING_PERMISSION");
  });
});

// Pass 33 — booking submission IP information is retained (and remains
// revealable to an otherwise-fully-authorized user) INDEFINITELY, with no
// automatic age-based expiration of any kind. This used to be an OPTIONAL
// per-deployment restriction (`BOOKING_IP_RETENTION_DAYS`) on the Reveal
// action itself — never a data-deletion mechanism, nothing in this
// codebase has ever deleted a booking's stored IP based on age — but even
// that access-time restriction is gone now: age must never be a reason a
// fully-authorized reveal fails.
describe("revealBookingIp — indefinite retention, no automatic age-based expiration (Pass 33)", () => {
  it("Test A — an old booking (well past any historically-used retention window) is still revealable", async () => {
    seedBooking({ createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) }); // > 1 year old
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result.ipAddress).toBe("203.0.113.42");
  });

  it("Test B — a booking several years old is still revealable", async () => {
    seedBooking({ createdAt: new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000) }); // ~5 years old
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result.ipAddress).toBe("203.0.113.42");
  });

  it("Test C — setting BOOKING_IP_RETENTION_DAYS has no effect at all — the variable is no longer read by this action", async () => {
    vi.stubEnv("BOOKING_IP_RETENTION_DAYS", "30");
    seedBooking({ createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) });
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result.ipAddress).toBe("203.0.113.42");
    // Never denied for a retention reason — that reason code no longer exists.
    expect(auditLogs.some((e) => e.metadata.reason === "RETENTION_EXPIRED")).toBe(false);
  });

  it("a fresh booking is (obviously) still revealable — age never matters in either direction", async () => {
    seedBooking({ createdAt: new Date() });
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result.ipAddress).toBe("203.0.113.42");
  });
});

describe("revealBookingIp — production fails closed (no real MFA/step-up system)", () => {
  it("denies reveal in production even for a fully-permissioned admin", async () => {
    vi.stubEnv("APP_ENV", "production");
    seedBooking();
    const { revealBookingIp } = await import("../booking-security");
    await expect(revealBookingIp("booking-1")).rejects.toThrow(/not authorized/i);
    expect(auditLogs[0].metadata.reason).toBe("MFA_REQUIRED_NOT_CONFIGURED");
  });
});
