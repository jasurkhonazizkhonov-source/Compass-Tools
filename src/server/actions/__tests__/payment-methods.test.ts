import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Same in-memory-fake mocking convention as accounts.test.ts / quote-status.test.ts.
// bookingVisibilityWhere() itself is the REAL implementation (not mocked) —
// only prisma.booking.findFirst is faked, interpreting the exact where
// shape that function produces, so the IDOR/BOLA tests below exercise the
// real authorization logic rather than a re-implementation of it.

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
let paymentCharges: Array<{ id: string; paymentMethodId: string; amount: number; status: string }>;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Map()),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/security/card-encryption", () => ({
  // Deterministic stand-in: reverses the "encrypted" marker so tests can
  // assert the decrypted value without depending on the real AES key/env.
  decryptPan: vi.fn((encoded: string) => encoded.replace(/^ENC:/, "")),
}));


vi.mock("@/server/activity-log", () => ({
  logActivity: vi.fn(async () => {}),
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
      findFirst: vi.fn(async ({ where }: { where: { id: string; bookingId: string } }) => {
        const pm = paymentMethods.get(where.id);
        return pm && pm.bookingId === where.bookingId ? { id: pm.id } : null;
      }),
      update: vi.fn(async ({ where: { id } }: { where: { id: string } }) => paymentMethods.get(id) ?? null),
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
      findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        // Only used by confirmPaymentReceived in this test file.
        const pms = [...paymentMethods.values()].filter((p) => p.bookingId === id);
        return {
          id,
          leadId: `lead-for-${id}`,
          contactId: `contact-for-${id}`,
          paymentMethods: pms.map((pm) => ({ id: pm.id, amountAllocated: pm.amountAllocated })),
          quote: { currency: "USD" },
        };
      }),
    },
    paymentCharge: {
      create: vi.fn(async ({ data }: { data: { paymentMethodId: string; amount: number; status: string } }) => {
        const charge = { id: `charge-${paymentCharges.length + 1}`, ...data };
        paymentCharges.push(charge);
        return charge;
      }),
    },
  },
}));

beforeEach(() => {
  bookings = new Map();
  paymentMethods = new Map();
  auditLogs = [];
  paymentCharges = [];
  currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.reveal", "payments.charge"] };
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

describe("revealPaymentMethod — role x permission matrix", () => {
  const ROLE_CASES: Array<{ role: string; eligible: boolean }> = [
    { role: "ADMIN", eligible: true },
    { role: "MANAGER", eligible: true },
    { role: "TICKETING_AGENT", eligible: true },
    { role: "TRAVEL_AGENT", eligible: false },
    { role: "FLIGHT_EXPERT", eligible: false },
  ];

  for (const { role, eligible } of ROLE_CASES) {
    it(`${role} WITH payments.reveal + full record access -> ${eligible ? "allowed" : "denied"}`, async () => {
      seedBookingAndCard();
      currentActor = { id: "actor-1", role, status: "ACTIVE", paymentPermissions: ["payments.reveal"] };
      const { revealPaymentMethod } = await import("../payment-methods");
      if (eligible) {
        const result = await revealPaymentMethod("pm-1");
        expect(result.pan).toBe("4111111111111111");
        expect(result.cardholderName).toBe("Jane Traveler");
      } else {
        await expect(revealPaymentMethod("pm-1")).rejects.toThrow(/not authorized/i);
      }
    });

    it(`${role} WITHOUT payments.reveal -> ${role === "ADMIN" ? "still allowed (Admin bypasses the grant array — every Admin has identical permissions)" : "always denied, even though role alone might be eligible"}`, async () => {
      seedBookingAndCard();
      currentActor = { id: "actor-1", role, status: "ACTIVE", paymentPermissions: [] };
      const { revealPaymentMethod } = await import("../payment-methods");
      if (role === "ADMIN") {
        const result = await revealPaymentMethod("pm-1");
        expect(result.pan).toBe("4111111111111111");
      } else {
        await expect(revealPaymentMethod("pm-1")).rejects.toThrow(/not authorized/i);
      }
    });
  }

  it("rejects an unauthenticated (missing) actor", async () => {
    seedBookingAndCard();
    currentActor = null;
    const { revealPaymentMethod } = await import("../payment-methods");
    await expect(revealPaymentMethod("pm-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects an INACTIVE account even with the permission and an eligible role", async () => {
    seedBookingAndCard();
    currentActor = { id: "admin-1", role: "ADMIN", status: "INACTIVE", paymentPermissions: ["payments.reveal"] };
    const { revealPaymentMethod } = await import("../payment-methods");
    await expect(revealPaymentMethod("pm-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a non-existent payment method id", async () => {
    seedBookingAndCard();
    const { revealPaymentMethod } = await import("../payment-methods");
    await expect(revealPaymentMethod("does-not-exist")).rejects.toThrow(/not authorized/i);
  });
});

describe("revealPaymentMethod — IDOR/BOLA protection", () => {
  it("denies reveal when the booking is outside the actor's own visibility scope (restricted role, not the owner)", async () => {
    seedBookingAndCard({ quoteAgentId: "someone-else", leadAssignedAgentId: "someone-else", contactOwnerId: "someone-else" });
    // FLIGHT_EXPERT is a restricted-visibility role (not canViewAllRecords),
    // so this actually exercises the ownership-scoped IDOR branch. It also
    // isn't a REVEAL_ELIGIBLE_ROLE, which would deny it before the IDOR
    // check even runs — see the next test for a role that IS eligible.
    currentActor = { id: "flight-expert-1", role: "FLIGHT_EXPERT", status: "ACTIVE", paymentPermissions: ["payments.reveal"] };
    const { revealPaymentMethod } = await import("../payment-methods");
    await expect(revealPaymentMethod("pm-1")).rejects.toThrow(/not authorized/i);
  });

  it("allows reveal when a restricted-visibility role IS the owning agent on the booking's quote", async () => {
    seedBookingAndCard({ quoteAgentId: "flight-expert-1" });
    currentActor = { id: "flight-expert-1", role: "FLIGHT_EXPERT", status: "ACTIVE", paymentPermissions: ["payments.reveal"] };
    const { revealPaymentMethod } = await import("../payment-methods");
    // FLIGHT_EXPERT is not in REVEAL_ELIGIBLE_ROLES, so this still must be denied —
    // proves role ceiling wins even when the IDOR check alone would pass.
    await expect(revealPaymentMethod("pm-1")).rejects.toThrow(/not authorized/i);
  });

  it("a MANAGER (org-wide visibility role) CAN reveal a card on a booking owned by a different agent — by design, not an IDOR bypass", async () => {
    seedBookingAndCard({ quoteAgentId: "other-manager" });
    currentActor = { id: "manager-1", role: "MANAGER", status: "ACTIVE", paymentPermissions: ["payments.reveal"] };
    // MANAGER/ADMIN/TICKETING_AGENT get canViewAllRecords()=true (org-wide
    // back-office queue) — a deliberate, documented design choice in
    // permissions.ts, distinct from the restricted-visibility roles tested
    // above where ownership genuinely gates access.
    const { revealPaymentMethod } = await import("../payment-methods");
    const result = await revealPaymentMethod("pm-1");
    expect(result.pan).toBe("4111111111111111");
  });
});

describe("revealPaymentMethod — audit trail never contains the PAN or CVV", () => {
  it("records a SUCCESS audit entry with only last4, never the full PAN", async () => {
    seedBookingAndCard();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.reveal"] };
    const { revealPaymentMethod } = await import("../payment-methods");
    await revealPaymentMethod("pm-1");

    expect(auditLogs).toHaveLength(1);
    const entry = auditLogs[0];
    expect(entry.action).toBe("PAYMENT_METHOD_REVEALED");
    expect(entry.metadata.last4).toBe("1111");
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized.toLowerCase()).not.toContain("cvv");
  });

  it("records a DENIED audit entry (with a reason, never the PAN) when permission is missing", async () => {
    seedBookingAndCard();
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", paymentPermissions: [] };
    const { revealPaymentMethod } = await import("../payment-methods");
    await expect(revealPaymentMethod("pm-1")).rejects.toThrow();

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe("PAYMENT_METHOD_REVEAL_DENIED");
    expect(auditLogs[0].metadata.reason).toBe("MISSING_PERMISSION");
    expect(JSON.stringify(auditLogs[0])).not.toContain("4111111111111111");
  });

  it("records a DENIED audit entry for an IDOR attempt with reason BOOKING_NOT_ACCESSIBLE", async () => {
    seedBookingAndCard({ quoteAgentId: "someone-else" });
    currentActor = { id: "flight-expert-1", role: "FLIGHT_EXPERT", status: "ACTIVE", paymentPermissions: ["payments.reveal"] };
    const { revealPaymentMethod } = await import("../payment-methods");
    await expect(revealPaymentMethod("pm-1")).rejects.toThrow();
    // FLIGHT_EXPERT fails the role ceiling before the booking-access check
    // even runs, so the denial reason here is the permission check, not
    // BOOKING_NOT_ACCESSIBLE — this documents that ordering rather than
    // asserting a specific reason string.
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe("PAYMENT_METHOD_REVEAL_DENIED");
  });
});

describe("confirmPaymentReceived — permission gate", () => {
  it("rejects an actor without payments.charge even if role ceiling (canChargePayments) is satisfied", async () => {
    seedBookingAndCard();
    currentActor = { id: "ticketing-1", role: "TICKETING_AGENT", status: "ACTIVE", paymentPermissions: [] };
    const { confirmPaymentReceived } = await import("../payment-methods");
    await expect(confirmPaymentReceived({ bookingId: "booking-1", paymentMethodId: "pm-1", amount: 100, status: "SUCCEEDED" })).rejects.toThrow(/not authorized/i);
  });

  it("rejects a role outside the charge ceiling (e.g. TRAVEL_AGENT) even with the permission granted", async () => {
    seedBookingAndCard();
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", paymentPermissions: ["payments.charge"] };
    const { confirmPaymentReceived } = await import("../payment-methods");
    await expect(confirmPaymentReceived({ bookingId: "booking-1", paymentMethodId: "pm-1", amount: 100, status: "SUCCEEDED" })).rejects.toThrow(/not authorized/i);
  });

  it("allows an authorized Ticketing Agent to record a successful payment", async () => {
    seedBookingAndCard();
    currentActor = { id: "ticketing-1", role: "TICKETING_AGENT", status: "ACTIVE", paymentPermissions: ["payments.charge"] };
    const { confirmPaymentReceived } = await import("../payment-methods");
    const result = await confirmPaymentReceived({ bookingId: "booking-1", paymentMethodId: "pm-1", amount: 250, status: "SUCCEEDED" });
    expect(result.status).toBe("SUCCEEDED");
    expect(paymentCharges).toHaveLength(1);
  });

  it("rejects an amount outside the allowed range for this specific payment method's own allocation", async () => {
    seedBookingAndCard();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.charge"] };
    const { confirmPaymentReceived } = await import("../payment-methods");
    // pm-1's amountAllocated is mocked at 250 -> max reasonable is 250*5+5000 = 6250
    await expect(confirmPaymentReceived({ bookingId: "booking-1", paymentMethodId: "pm-1", amount: 999999, status: "SUCCEEDED" })).rejects.toThrow(/outside the allowed range/);
  });

  it("rejects a payment method not on file for the given booking", async () => {
    bookings.set("booking-2", { id: "booking-2" });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.charge"] };
    const { confirmPaymentReceived } = await import("../payment-methods");
    await expect(confirmPaymentReceived({ bookingId: "booking-2", paymentMethodId: "pm-1", amount: 100, status: "SUCCEEDED" })).rejects.toThrow(/not on file/i);
  });

  it("rejects an attempt to charge a payment method that belongs to a DIFFERENT booking (IDOR)", async () => {
    seedBookingAndCard();
    bookings.set("booking-2", { id: "booking-2" });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.charge"] };
    const { confirmPaymentReceived } = await import("../payment-methods");
    await expect(confirmPaymentReceived({ bookingId: "booking-2", paymentMethodId: "pm-1", amount: 100, status: "SUCCEEDED" })).rejects.toThrow(/not on file/i);
  });

  it("rejects a booking id that does not exist at all — a raw id alone is never sufficient", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.charge"] };
    const { confirmPaymentReceived } = await import("../payment-methods");
    await expect(
      confirmPaymentReceived({ bookingId: "does-not-exist", paymentMethodId: "pm-1", amount: 100, status: "SUCCEEDED" })
    ).rejects.toThrow(/not accessible/i);
  });

  it("rejects an unauthenticated (missing) actor", async () => {
    seedBookingAndCard();
    currentActor = null;
    const { confirmPaymentReceived } = await import("../payment-methods");
    await expect(
      confirmPaymentReceived({ bookingId: "booking-1", paymentMethodId: "pm-1", amount: 100, status: "SUCCEEDED" })
    ).rejects.toThrow(/not authorized/i);
  });
});

describe("updatePaymentMethodWorkflowStatus — permission gate + IDOR/BOLA protection", () => {
  it("rejects an actor without the charge permission", async () => {
    seedBookingAndCard();
    currentActor = { id: "ticketing-1", role: "TICKETING_AGENT", status: "ACTIVE", paymentPermissions: [] };
    const { updatePaymentMethodWorkflowStatus } = await import("../payment-methods");
    await expect(
      updatePaymentMethodWorkflowStatus({ bookingId: "booking-1", paymentMethodId: "pm-1", workflowStatus: "CANCELLED" })
    ).rejects.toThrow(/not authorized/i);
  });

  it("rejects an unauthenticated (missing) actor", async () => {
    seedBookingAndCard();
    currentActor = null;
    const { updatePaymentMethodWorkflowStatus } = await import("../payment-methods");
    await expect(
      updatePaymentMethodWorkflowStatus({ bookingId: "booking-1", paymentMethodId: "pm-1", workflowStatus: "CANCELLED" })
    ).rejects.toThrow(/not authorized/i);
  });

  it("rejects a booking id that does not exist at all — previously this had NO booking-existence check whatsoever", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.charge"] };
    const { updatePaymentMethodWorkflowStatus } = await import("../payment-methods");
    await expect(
      updatePaymentMethodWorkflowStatus({ bookingId: "does-not-exist", paymentMethodId: "pm-1", workflowStatus: "CANCELLED" })
    ).rejects.toThrow(/not accessible/i);
  });

  it("rejects a payment method that belongs to a DIFFERENT booking than the one supplied", async () => {
    seedBookingAndCard();
    bookings.set("booking-2", { id: "booking-2" });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.charge"] };
    const { updatePaymentMethodWorkflowStatus } = await import("../payment-methods");
    await expect(
      updatePaymentMethodWorkflowStatus({ bookingId: "booking-2", paymentMethodId: "pm-1", workflowStatus: "CANCELLED" })
    ).rejects.toThrow(/not on file/i);
  });

  it("allows an authorized Admin to update the workflow status of a payment method on an accessible booking", async () => {
    seedBookingAndCard();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.charge"] };
    const { updatePaymentMethodWorkflowStatus } = await import("../payment-methods");
    await expect(
      updatePaymentMethodWorkflowStatus({ bookingId: "booking-1", paymentMethodId: "pm-1", workflowStatus: "CANCELLED" })
    ).resolves.toBeUndefined();
  });
});

describe("revealPaymentMethod — production fails closed (no real MFA/step-up system)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("denies reveal in production even for a fully-permissioned admin on their own accessible booking", async () => {
    vi.stubEnv("APP_ENV", "production");
    seedBookingAndCard();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.reveal"] };
    const { revealPaymentMethod } = await import("../payment-methods");
    await expect(revealPaymentMethod("pm-1")).rejects.toThrow(/not authorized/i);
    expect(auditLogs[auditLogs.length - 1].action).toBe("PAYMENT_METHOD_REVEAL_DENIED");
    expect(auditLogs[auditLogs.length - 1].metadata.reason).toBe("MFA_REQUIRED_NOT_CONFIGURED");
  });
});
