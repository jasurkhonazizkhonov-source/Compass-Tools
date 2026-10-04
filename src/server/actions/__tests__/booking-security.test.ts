import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Same in-memory-fake convention as payment-methods.test.ts. bookingVisibilityWhere()
// is the REAL implementation — only prisma.booking.findFirst is faked, interpreting
// the exact where shape it produces, so IDOR tests exercise real authorization logic.

type FakeAccount = { id: string; role: string; status: string; bookingPermissions: string[]; sessionCreatedAt?: Date | null };
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
type FakeCapture = { ipVersion: string; capturedAt: Date; geoCity: string | null; geoRegion: string | null; geoCountry: string | null; geoCountryCode: string | null; geoTimeZone: string | null; geoSource: string | null };
let captureRow: FakeCapture | null;
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
        return { id: row.id, createdAt: row.createdAt, signature: { ipAddress: row.ipAddress, userAgent: null, signedAt: new Date("2026-10-01T10:00:00Z") } };
      }),
    },
    ipCapture: {
      findFirst: vi.fn(async () => captureRow),
    },
  },
}));

beforeEach(() => {
  captureRow = null;
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
      // A Manager only reaches bookings in their own scope now, so for that role the booking is theirs.
      seedBooking(role === "MANAGER" ? { quoteAgentId: "actor-1" } : {});
      currentActor = { id: "actor-1", role, status: "ACTIVE", bookingPermissions: ["bookings.reveal_ip"] };
      const { revealBookingIp } = await import("../booking-security");
      if (eligible) {
        const result = await revealBookingIp("booking-1");
        expect(result).toMatchObject({ ipAddress: "203.0.113.42" });
      } else {
        await expect(revealBookingIp("booking-1")).rejects.toThrow(/not authorized/i);
      }
    });

    it(`${role} WITHOUT bookings.reveal_ip -> ${role === "ADMIN" ? "still allowed (Admin bypasses the grant array)" : "always denied"}`, async () => {
      seedBooking(role === "MANAGER" ? { quoteAgentId: "actor-1" } : {});
      currentActor = { id: "actor-1", role, status: "ACTIVE", bookingPermissions: [] };
      const { revealBookingIp } = await import("../booking-security");
      if (role === "ADMIN") {
        const result = await revealBookingIp("booking-1");
        expect(result).toMatchObject({ ipAddress: "203.0.113.42" });
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
    // A Manager is no longer company-wide: with the explicit grant AND an eligible
    // role they still cannot reveal the IP of a booking outside their own team
    // (the role ceiling and the grant are unchanged; the row scope narrowed).
    currentActor = { id: "manager-1", role: "MANAGER", status: "ACTIVE", bookingPermissions: ["bookings.reveal_ip"] };
    const { revealBookingIp } = await import("../booking-security");
    await expect(revealBookingIp("booking-1")).rejects.toThrow(/not authorized/i);
  });

  it("a Manager CAN reveal the IP on a booking that is within their own scope (the grant is still required)", async () => {
    seedBooking({ quoteAgentId: "manager-1" });
    currentActor = { id: "manager-1", role: "MANAGER", status: "ACTIVE", bookingPermissions: ["bookings.reveal_ip"] };
    const { revealBookingIp } = await import("../booking-security");
    expect(await revealBookingIp("booking-1")).toMatchObject({ ipAddress: "203.0.113.42" });
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
    expect(result).toMatchObject({ ipAddress: "203.0.113.42" });
  });

  it("Test B — a booking several years old is still revealable", async () => {
    seedBooking({ createdAt: new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000) }); // ~5 years old
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result).toMatchObject({ ipAddress: "203.0.113.42" });
  });

  it("Test C — setting BOOKING_IP_RETENTION_DAYS has no effect at all — the variable is no longer read by this action", async () => {
    vi.stubEnv("BOOKING_IP_RETENTION_DAYS", "30");
    seedBooking({ createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) });
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result).toMatchObject({ ipAddress: "203.0.113.42" });
    // Never denied for a retention reason — that reason code no longer exists.
    expect(auditLogs.some((e) => e.metadata.reason === "RETENTION_EXPIRED")).toBe(false);
  });

  it("a fresh booking is (obviously) still revealable — age never matters in either direction", async () => {
    seedBooking({ createdAt: new Date() });
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result).toMatchObject({ ipAddress: "203.0.113.42" });
  });
});

describe("revealBookingIp — approximate IP-derived location and signing time", () => {
  const GEO: FakeCapture = { ipVersion: "v4", capturedAt: new Date("2026-10-01T10:00:00Z"), geoCity: "Los Angeles", geoRegion: "California", geoCountry: "United States", geoCountryCode: "US", geoTimeZone: "America/Los_Angeles", geoSource: "Vercel edge geolocation (approximate)" };

  it("returns the full IP with the city, country, region and time zone captured WITH the signing event, plus the signing time and IP version", async () => {
    seedBooking();
    captureRow = GEO;
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result).toEqual({
      ipAddress: "203.0.113.42",
      userAgent: null,
      ipVersion: "v4",
      signedAt: new Date("2026-10-01T10:00:00Z"),
      location: { city: "Los Angeles", region: "California", country: "United States", countryCode: "US", timeZone: "America/Los_Angeles", source: "Vercel edge geolocation (approximate)" },
    });
  });

  it("an IPv6 signer is labelled v6 and returned in full", async () => {
    seedBooking({ ipAddress: "2001:db8:85a3::8a2e:370:7334" });
    captureRow = { ...GEO, ipVersion: "v6" };
    const { revealBookingIp } = await import("../booking-security");
    expect(await revealBookingIp("booking-1")).toMatchObject({ ipAddress: "2001:db8:85a3::8a2e:370:7334", ipVersion: "v6" });
  });

  it("when only the country was supplied the city stays null — nothing is invented", async () => {
    seedBooking();
    captureRow = { ...GEO, geoCity: null, geoRegion: null, geoTimeZone: null };
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result).toMatchObject({ location: { city: null, region: null, country: "United States", countryCode: "US", timeZone: null } });
  });

  it("an older booking whose capture holds no location (or no capture row at all) reports location: null — never a fabricated place", async () => {
    seedBooking();
    const { revealBookingIp } = await import("../booking-security");
    captureRow = { ...GEO, geoCity: null, geoRegion: null, geoCountry: null, geoCountryCode: null, geoTimeZone: null, geoSource: null };
    expect(await revealBookingIp("booking-1")).toMatchObject({ ipAddress: "203.0.113.42", location: null });
    captureRow = null;
    expect(await revealBookingIp("booking-1")).toMatchObject({ ipAddress: "203.0.113.42", location: null });
  });

  it("the audit entry for a reveal never contains the IP or the location", async () => {
    seedBooking();
    captureRow = GEO;
    const { revealBookingIp } = await import("../booking-security");
    await revealBookingIp("booking-1");
    const audit = JSON.stringify(auditLogs);
    expect(auditLogs).toHaveLength(1);
    for (const secret of ["203.0.113.42", "Los Angeles", "California", "United States", "America/Los_Angeles"]) expect(audit).not.toContain(secret);
  });

  it("an unauthorised role gets neither the IP nor the location (the capture is not even read)", async () => {
    seedBooking();
    captureRow = GEO;
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", bookingPermissions: ["bookings.reveal_ip"] };
    const { revealBookingIp } = await import("../booking-security");
    await expect(revealBookingIp("booking-1")).rejects.toThrow(/not authorized/i);
    const prismaMock = (await import("@/lib/prisma")).prisma as unknown as { ipCapture: { findFirst: ReturnType<typeof vi.fn> } };
    expect(prismaMock.ipCapture.findFirst).not.toHaveBeenCalled();
  });

  it("a stale session gets only the returned step-up error — no IP, no location, and the capture is not read", async () => {
    vi.stubEnv("APP_ENV", "production");
    seedBooking();
    captureRow = GEO;
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", bookingPermissions: [], sessionCreatedAt: new Date(Date.now() - 60 * 60 * 1000) };
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(result)).not.toMatch(/203.0.113|Los Angeles/);
  });
});

describe("revealBookingIp — recent sign-in step-up (same real check as the card Reveal)", () => {
  const MIN = 60 * 1000;

  it("in production, a fully-permissioned admin with a STALE session gets a RETURNED, actionable error (not a throw) and the IP is not disclosed", async () => {
    vi.stubEnv("APP_ENV", "production");
    seedBooking();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", bookingPermissions: [], sessionCreatedAt: new Date(Date.now() - 16 * MIN) };
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result).toEqual({ error: expect.stringMatching(/sign-in within the last 15 minutes/i) });
    expect(JSON.stringify(result)).not.toContain("203.0.113.42");
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe("BOOKING_IP_REVEAL_DENIED");
    expect(auditLogs[0].metadata.reason).toBe("RECENT_LOGIN_REQUIRED");
  });

  it("in production, an account with no recorded sign-in time is refused the same way", async () => {
    vi.stubEnv("APP_ENV", "production");
    seedBooking();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", bookingPermissions: [], sessionCreatedAt: null };
    const { revealBookingIp } = await import("../booking-security");
    expect(await revealBookingIp("booking-1")).toEqual({ error: expect.any(String) });
  });

  it("in production, an admin who signed in recently CAN reveal (the regression: this used to always throw, masked as React error #441)", async () => {
    vi.stubEnv("APP_ENV", "production");
    seedBooking();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", bookingPermissions: [], sessionCreatedAt: new Date(Date.now() - 2 * MIN) };
    const { revealBookingIp } = await import("../booking-security");
    const result = await revealBookingIp("booking-1");
    expect(result).toMatchObject({ ipAddress: "203.0.113.42", userAgent: null });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe("BOOKING_IP_REVEALED");
    expect(JSON.stringify(auditLogs[0].metadata)).not.toContain("203.0.113.42");
  });

  it("in production, authorization failures still THROW the generic denial, even with a fresh session (role / IDOR are checked before the step-up)", async () => {
    vi.stubEnv("APP_ENV", "production");
    seedBooking({ quoteAgentId: "someone-else" });
    const fresh = new Date(Date.now() - MIN);
    const { revealBookingIp } = await import("../booking-security");
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", bookingPermissions: ["bookings.reveal_ip"], sessionCreatedAt: fresh };
    await expect(revealBookingIp("booking-1")).rejects.toThrow(/not authorized/i);
    currentActor = { id: "mgr-1", role: "MANAGER", status: "ACTIVE", bookingPermissions: ["bookings.reveal_ip"], sessionCreatedAt: fresh };
    await expect(revealBookingIp("booking-1")).rejects.toThrow(/not authorized/i);
    expect(auditLogs.map((e) => e.metadata.reason)).toEqual(["MISSING_PERMISSION", "BOOKING_NOT_ACCESSIBLE"]);
  });
});
