import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cacheCvv, destroyCvv, __resetCvvCacheForTests } from "../cvv-cache";

// Same in-memory-fake mocking convention as payment-methods.test.ts.
// bookingVisibilityWhere() and canAuthorizeSupplierPayment() are the REAL
// implementations — only prisma is faked.
//
// startSupplierPaymentAuthorization/endSupplierPaymentAuthorization return a
// predictable { success, code, message } result rather than throwing for
// every expected failure path (see SupplierPaymentActionResult) — assertions
// below check `result.success` before narrowing to the success/failure shape.

type FakeAccount = { id: string; role: string; status: string; paymentPermissions: string[] };
type FakeBooking = { id: string; quoteAgentId?: string; leadAssignedAgentId?: string; contactOwnerId?: string };
type FakePaymentMethod = {
  id: string;
  bookingId: string;
  encryptedPan: string;
  cardholderName: string;
  cardBrand: string | null;
  expiryMonth: number;
  expiryYear: number;
  last4: string;
  amountAllocated: number;
};

let currentActor: FakeAccount | null;
let bookings: Map<string, FakeBooking>;
let paymentMethods: Map<string, FakePaymentMethod>;
let auditLogs: Array<{ actorId: string | undefined; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> }>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Map()),
}));

vi.mock("@/server/security/card-encryption", () => ({
  decryptPan: vi.fn((encoded: string) => encoded.replace(/^ENC:/, "")),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async ({ data }: { data: { actorId: string | undefined; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> } }) => {
        auditLogs.push(data);
        return data;
      }),
    },
    paymentMethod: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => paymentMethods.get(id) ?? null),
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
        return { id: row.id };
      }),
    },
  },
}));

beforeEach(() => {
  bookings = new Map();
  paymentMethods = new Map();
  auditLogs = [];
  __resetCvvCacheForTests();
  currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.manual_supplier_payment"] };
  vi.clearAllMocks();
});

function seedBookingAndCard(overrides: Partial<FakeBooking> = {}) {
  bookings.set("booking-1", { id: "booking-1", ...overrides });
  paymentMethods.set("pm-1", {
    id: "pm-1",
    bookingId: "booking-1",
    encryptedPan: "ENC:4111111111111111",
    cardholderName: "Jane Traveler",
    cardBrand: "Visa",
    expiryMonth: 8,
    expiryYear: 2029,
    last4: "1111",
    amountAllocated: 250,
  });
}

describe("startSupplierPaymentAuthorization — permission gate (stricter than plain Reveal)", () => {
  it("payments.reveal ALONE (no payments.manual_supplier_payment) is NOT sufficient for a non-Admin — this workflow is deliberately more sensitive", async () => {
    seedBookingAndCard();
    cacheCvv("pm-1", "123");
    currentActor = { id: "manager-1", role: "MANAGER", status: "ACTIVE", paymentPermissions: ["payments.reveal"] };
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(false);
  });

  it("an Admin is authorized regardless of grants — every Admin has identical permissions", async () => {
    seedBookingAndCard();
    cacheCvv("pm-1", "123");
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: [] };
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(true);
  });

  const ROLE_CASES: Array<{ role: string; eligible: boolean }> = [
    { role: "ADMIN", eligible: true },
    { role: "MANAGER", eligible: true },
    { role: "TICKETING_AGENT", eligible: true },
    { role: "TRAVEL_AGENT", eligible: false },
    { role: "FLIGHT_EXPERT", eligible: false },
  ];

  for (const { role, eligible } of ROLE_CASES) {
    it(`${role} with the explicit grant -> ${eligible ? "allowed" : "denied"}`, async () => {
      seedBookingAndCard();
      cacheCvv("pm-1", "123");
      currentActor = { id: "actor-1", role, status: "ACTIVE", paymentPermissions: ["payments.manual_supplier_payment"] };
      const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
      const result = await startSupplierPaymentAuthorization("pm-1");
      expect(result.success).toBe(eligible);
      if (eligible && result.success) {
        expect(result.pan).toBe("4111111111111111");
        expect(result.cvv).toBe("123");
        expect(result.cvvAvailable).toBe(true);
      }
    });
  }

  it("rejects an unauthenticated actor", async () => {
    seedBookingAndCard();
    currentActor = null;
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe("NO_ACTIVE_SESSION");
  });

  it("rejects an INACTIVE account even with the permission and an eligible role", async () => {
    seedBookingAndCard();
    currentActor = { id: "admin-1", role: "ADMIN", status: "INACTIVE", paymentPermissions: ["payments.manual_supplier_payment"] };
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(false);
  });

  it("denies access when the booking is outside the actor's own visibility scope (IDOR/BOLA)", async () => {
    seedBookingAndCard({ quoteAgentId: "someone-else", leadAssignedAgentId: "someone-else", contactOwnerId: "someone-else" });
    currentActor = { id: "flight-expert-1", role: "FLIGHT_EXPERT", status: "ACTIVE", paymentPermissions: ["payments.manual_supplier_payment"] };
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(false);
  });
});

describe("startSupplierPaymentAuthorization — CVV availability reflects the real cache state", () => {
  it("cvvAvailable is true and returns the CVV immediately after a fresh booking submission", async () => {
    seedBookingAndCard();
    cacheCvv("pm-1", "456");
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.cvvAvailable).toBe(true);
      expect(result.cvv).toBe("456");
    }
  });

  it("cvvAvailable is false, cvv is null, when no CVV was ever cached for this payment method", async () => {
    seedBookingAndCard(); // no cacheCvv() call
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.cvvAvailable).toBe(false);
      expect(result.cvv).toBeNull();
    }
  });

  it("cvvAvailable is false after the authorization has already been ended — no historical retrieval", async () => {
    seedBookingAndCard();
    cacheCvv("pm-1", "456");
    const { startSupplierPaymentAuthorization, endSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const first = await startSupplierPaymentAuthorization("pm-1");
    expect(first.success).toBe(true);
    if (first.success) expect(first.cvvAvailable).toBe(true);

    await endSupplierPaymentAuthorization("pm-1");

    const second = await startSupplierPaymentAuthorization("pm-1");
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.cvvAvailable).toBe(false);
      expect(second.cvv).toBeNull();
      // The PAN is still legitimately retained data — only the CVV is gone.
      expect(second.pan).toBe("4111111111111111");
    }
  });

  it("destroying a payment method's CVV externally (e.g. via confirmPaymentReceived) is reflected here too", async () => {
    seedBookingAndCard();
    cacheCvv("pm-1", "789");
    destroyCvv("pm-1"); // simulates confirmPaymentReceived's cleanup
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(true);
    if (result.success) expect(result.cvvAvailable).toBe(false);
  });

  it("one card's CVV is never returned for a different card on the same booking", async () => {
    seedBookingAndCard();
    paymentMethods.set("pm-2", { ...paymentMethods.get("pm-1")!, id: "pm-2", last4: "2222" });
    cacheCvv("pm-1", "111");
    cacheCvv("pm-2", "222");
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const r1 = await startSupplierPaymentAuthorization("pm-1");
    const r2 = await startSupplierPaymentAuthorization("pm-2");
    expect(r1.success && r1.cvv).toBe("111");
    expect(r2.success && r2.cvv).toBe("222");
  });
});

describe("startSupplierPaymentAuthorization — audit trail never contains the PAN or CVV", () => {
  it("records a SUCCESS audit entry with only last4, never the PAN or CVV value", async () => {
    seedBookingAndCard();
    cacheCvv("pm-1", "456");
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    await startSupplierPaymentAuthorization("pm-1");

    expect(auditLogs).toHaveLength(1);
    const entry = auditLogs[0];
    expect(entry.action).toBe("SUPPLIER_PAYMENT_AUTHORIZATION_STARTED");
    expect(entry.metadata.last4).toBe("1111");
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized).not.toContain("456");
  });

  it("records a DENIED audit entry when the permission is missing, never the PAN or CVV", async () => {
    seedBookingAndCard();
    cacheCvv("pm-1", "456");
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", paymentPermissions: [] };
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(false);

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe("SUPPLIER_PAYMENT_AUTHORIZATION_DENIED");
    expect(JSON.stringify(auditLogs[0])).not.toContain("456");
  });
});

describe("startSupplierPaymentAuthorization — production fails closed (no real MFA/step-up system)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("denies authorization in production even for a fully-permissioned admin on their own accessible booking", async () => {
    vi.stubEnv("APP_ENV", "production");
    seedBookingAndCard();
    cacheCvv("pm-1", "456");
    const { startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(false);
    expect(auditLogs[auditLogs.length - 1].action).toBe("SUPPLIER_PAYMENT_AUTHORIZATION_DENIED");
    expect(auditLogs[auditLogs.length - 1].metadata.reason).toBe("MFA_REQUIRED_NOT_CONFIGURED");
  });
});

describe("endSupplierPaymentAuthorization", () => {
  it("destroys the cached CVV and records an audit entry", async () => {
    seedBookingAndCard();
    cacheCvv("pm-1", "456");
    const { endSupplierPaymentAuthorization, startSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const endResult = await endSupplierPaymentAuthorization("pm-1");
    expect(endResult.success).toBe(true);
    const result = await startSupplierPaymentAuthorization("pm-1");
    expect(result.success && result.cvvAvailable).toBe(false);
    expect(auditLogs.some((a) => a.action === "SUPPLIER_PAYMENT_AUTHORIZATION_ENDED")).toBe(true);
  });

  it("rejects an unauthorized actor from ending an authorization", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", paymentPermissions: [] };
    const { endSupplierPaymentAuthorization } = await import("../cvv-authorization");
    const result = await endSupplierPaymentAuthorization("pm-1");
    expect(result.success).toBe(false);
  });
});
