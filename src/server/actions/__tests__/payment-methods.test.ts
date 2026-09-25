import { describe, it, expect, vi, beforeEach } from "vitest";

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
    cardholderName: "Jane Traveler",
    cardBrand: "Visa",
    expiryMonth: 8,
    expiryYear: 2029,
    last4: "1111",
    amountAllocated: 250,
  });
}

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

describe("card reveal no longer exists", () => {
  it("the action module exports NO way to reveal a card number — Compass Tools holds none (the provider vaults it)", async () => {
    const mod = await import("../payment-methods");
    expect(Object.keys(mod)).not.toContain("revealPaymentMethod");
    expect(Object.keys(mod).join(",")).not.toMatch(/reveal/i);
  });
});
