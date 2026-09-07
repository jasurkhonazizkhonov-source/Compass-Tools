import { describe, it, expect, vi, beforeEach } from "vitest";

type FakeAccount = { id: string; role: string; status: string; paymentPermissions: string[] };
type FakeContact = { id: string; ownerId?: string };
type FakePaymentMethod = {
  id: string;
  bookingId: string | null;
  contactId: string | null;
  encryptedPan: string;
  cardholderName: string;
  cardBrand: string | null;
  expiryMonth: number;
  expiryYear: number;
  last4: string;
  status: string;
};

let currentActor: FakeAccount | null;
let contacts: Map<string, FakeContact>;
let paymentMethods: Map<string, FakePaymentMethod>;
let auditLogs: Array<{ actorId: string | undefined; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> }>;
let nextId = 1;

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

vi.mock("@/server/security/card-encryption", () => ({
  // store() is exercised via getPaymentVault().store — deterministic stand-in
  // matching the convention in payment-methods.test.ts.
  encryptPan: vi.fn((digits: string) => `ENC:${digits}`),
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
    contact: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = contacts.get(where.id as string);
        if (!row) return null;
        if (where.ownerId !== undefined && row.ownerId !== where.ownerId) return null;
        return { id: row.id };
      }),
    },
    paymentMethod: {
      create: vi.fn(async ({ data }: { data: Partial<FakePaymentMethod> }) => {
        const pm: FakePaymentMethod = {
          id: `pm-${nextId++}`,
          status: "ACTIVE",
          bookingId: null,
          contactId: null,
          encryptedPan: "",
          cardholderName: "",
          cardBrand: null,
          expiryMonth: 0,
          expiryYear: 0,
          last4: "",
          ...data,
        };
        paymentMethods.set(pm.id, pm);
        return pm;
      }),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => paymentMethods.get(id) ?? null),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakePaymentMethod> }) => {
        const pm = paymentMethods.get(id);
        if (!pm) throw new Error("not found");
        Object.assign(pm, data);
        return pm;
      }),
    },
  },
}));

beforeEach(() => {
  contacts = new Map();
  paymentMethods = new Map();
  auditLogs = [];
  nextId = 1;
  currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: ["payments.collect"] };
  vi.clearAllMocks();
});

const VALID_CARD = { cardNumber: "4111 1111 1111 1111", expiryMonth: 8, expiryYear: new Date().getFullYear() + 3 };

describe("addContactPaymentMethod — permission gate", () => {
  const ROLE_CASES: Array<{ role: string; eligible: boolean }> = [
    { role: "ADMIN", eligible: true },
    { role: "MANAGER", eligible: true },
    { role: "TICKETING_AGENT", eligible: true },
    { role: "TRAVEL_AGENT", eligible: false },
    { role: "FLIGHT_EXPERT", eligible: false },
  ];

  for (const { role, eligible } of ROLE_CASES) {
    it(`${role} with payments.collect -> ${eligible ? "allowed" : "denied"}`, async () => {
      contacts.set("contact-1", { id: "contact-1" });
      currentActor = { id: "actor-1", role, status: "ACTIVE", paymentPermissions: ["payments.collect"] };
      const { addContactPaymentMethod } = await import("../contact-payment-methods");
      if (eligible) {
        const result = await addContactPaymentMethod({ contactId: "contact-1", cardholderName: "Jane Traveler", ...VALID_CARD });
        expect(result.last4).toBe("1111");
      } else {
        await expect(addContactPaymentMethod({ contactId: "contact-1", cardholderName: "Jane Traveler", ...VALID_CARD })).rejects.toThrow(/not authorized/i);
      }
    });
  }

  it("a non-Admin account without the payments.collect grant is denied even with an eligible role", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    currentActor = { id: "manager-1", role: "MANAGER", status: "ACTIVE", paymentPermissions: [] };
    const { addContactPaymentMethod } = await import("../contact-payment-methods");
    await expect(addContactPaymentMethod({ contactId: "contact-1", cardholderName: "Jane Traveler", ...VALID_CARD })).rejects.toThrow(/not authorized/i);
  });

  it("an Admin is allowed even with an empty grant array — every Admin has identical permissions, never gated by that account's own grants", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: [] };
    const { addContactPaymentMethod } = await import("../contact-payment-methods");
    const result = await addContactPaymentMethod({ contactId: "contact-1", cardholderName: "Jane Traveler", ...VALID_CARD });
    expect(result.last4).toBe("1111");
  });
});

describe("addContactPaymentMethod — IDOR/BOLA and validation", () => {
  // Note: canManageContactPaymentMethods' role ceiling (ADMIN/MANAGER/
  // TICKETING_AGENT) is exactly the same set of roles canViewAllRecords()
  // grants org-wide visibility to (see visibility.ts's own comment on why —
  // ticketing/payment is a deliberately shared cross-agent back-office
  // queue). So there is no role that is both eligible to manage payment
  // methods and subject to ownership-scoped visibility — the IDOR check
  // itself (canAccessPaymentMethod, including its Contact-ownership branch)
  // is independently and thoroughly covered in
  // src/server/__tests__/payment-method-access.test.ts using a genuinely
  // restricted-visibility role; this file focuses on the permission-ceiling
  // and validation checks specific to these actions instead.
  it("denies a restricted-visibility, non-eligible role outright (role ceiling)", async () => {
    contacts.set("contact-1", { id: "contact-1", ownerId: "someone-else" });
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", paymentPermissions: ["payments.collect"] };
    const { addContactPaymentMethod } = await import("../contact-payment-methods");
    await expect(addContactPaymentMethod({ contactId: "contact-1", cardholderName: "Jane Traveler", ...VALID_CARD })).rejects.toThrow(/not authorized/i);
  });

  it("denies adding a card to a contact that does not exist at all", async () => {
    const { addContactPaymentMethod } = await import("../contact-payment-methods");
    await expect(addContactPaymentMethod({ contactId: "does-not-exist", cardholderName: "Jane Traveler", ...VALID_CARD })).rejects.toThrow(/not authorized/i);
  });

  it("rejects an invalid card number (fails Luhn)", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    const { addContactPaymentMethod } = await import("../contact-payment-methods");
    await expect(
      addContactPaymentMethod({ contactId: "contact-1", cardholderName: "Jane Traveler", cardNumber: "4111 1111 1111 1112", expiryMonth: 8, expiryYear: new Date().getFullYear() + 3 })
    ).rejects.toThrow(/could not be processed/i);
  });

  it("rejects an expired card", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    const { addContactPaymentMethod } = await import("../contact-payment-methods");
    await expect(
      addContactPaymentMethod({ contactId: "contact-1", cardholderName: "Jane Traveler", cardNumber: "4111 1111 1111 1111", expiryMonth: 1, expiryYear: 2000 })
    ).rejects.toThrow(/could not be processed/i);
  });

  it("stores the card attributed to the contact, never a booking", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    const { addContactPaymentMethod } = await import("../contact-payment-methods");
    const result = await addContactPaymentMethod({ contactId: "contact-1", cardholderName: "Jane Traveler", ...VALID_CARD });
    const stored = paymentMethods.get(result.id)!;
    expect(stored.contactId).toBe("contact-1");
    expect(stored.bookingId).toBeNull();
  });
});

function seedContactCard(overrides: Partial<FakePaymentMethod> = {}) {
  contacts.set("contact-1", { id: "contact-1" });
  const pm: FakePaymentMethod = {
    id: "pm-1",
    bookingId: null,
    contactId: "contact-1",
    encryptedPan: "ENC:4111111111111111",
    cardholderName: "Jane Traveler",
    cardBrand: "Visa",
    expiryMonth: 8,
    expiryYear: 2029,
    last4: "1111",
    status: "ACTIVE",
    ...overrides,
  };
  paymentMethods.set(pm.id, pm);
  return pm;
}

describe("editPaymentMethod", () => {
  it("updates cardholder name and expiry without touching the PAN when no replacement card number is given", async () => {
    seedContactCard();
    const { editPaymentMethod } = await import("../contact-payment-methods");
    await editPaymentMethod({ paymentMethodId: "pm-1", cardholderName: "Jane R. Traveler", expiryMonth: 9, expiryYear: 2030 });
    const updated = paymentMethods.get("pm-1")!;
    expect(updated.cardholderName).toBe("Jane R. Traveler");
    expect(updated.expiryMonth).toBe(9);
    expect(updated.encryptedPan).toBe("ENC:4111111111111111"); // unchanged
    expect(updated.last4).toBe("1111"); // unchanged
  });

  it("replaces the PAN via secure re-entry when a new card number is provided", async () => {
    seedContactCard();
    const { editPaymentMethod } = await import("../contact-payment-methods");
    await editPaymentMethod({ paymentMethodId: "pm-1", cardholderName: "Jane Traveler", expiryMonth: 8, expiryYear: 2029, cardNumber: "5555 5555 5555 4444" });
    const updated = paymentMethods.get("pm-1")!;
    expect(updated.last4).toBe("4444");
    expect(updated.cardBrand).toBe("Mastercard");
  });

  it("rejects an invalid replacement card number", async () => {
    seedContactCard();
    const { editPaymentMethod } = await import("../contact-payment-methods");
    await expect(editPaymentMethod({ paymentMethodId: "pm-1", cardholderName: "Jane Traveler", expiryMonth: 8, expiryYear: 2029, cardNumber: "1234 5678 9012 3456" })).rejects.toThrow(/could not be processed/i);
  });

  it("denies a restricted-visibility, non-eligible role outright (role ceiling)", async () => {
    seedContactCard();
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", paymentPermissions: ["payments.collect"] };
    const { editPaymentMethod } = await import("../contact-payment-methods");
    await expect(editPaymentMethod({ paymentMethodId: "pm-1", cardholderName: "Someone Else", expiryMonth: 8, expiryYear: 2029 })).rejects.toThrow(/not authorized/i);
  });

  it("rejects editing a non-existent payment method", async () => {
    const { editPaymentMethod } = await import("../contact-payment-methods");
    await expect(editPaymentMethod({ paymentMethodId: "does-not-exist", cardholderName: "Jane", expiryMonth: 8, expiryYear: 2029 })).rejects.toThrow(/not authorized/i);
  });
});

describe("removePaymentMethod", () => {
  it("soft-deletes via status=ARCHIVED — never a hard delete", async () => {
    seedContactCard();
    const { removePaymentMethod } = await import("../contact-payment-methods");
    await removePaymentMethod("pm-1");
    const row = paymentMethods.get("pm-1")!;
    expect(row.status).toBe("ARCHIVED");
    expect(paymentMethods.has("pm-1")).toBe(true); // row still exists
  });

  it("denies removal for an unauthorized role", async () => {
    seedContactCard();
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE", paymentPermissions: ["payments.collect"] };
    const { removePaymentMethod } = await import("../contact-payment-methods");
    await expect(removePaymentMethod("pm-1")).rejects.toThrow(/not authorized/i);
    expect(paymentMethods.get("pm-1")!.status).toBe("ACTIVE"); // unchanged
  });

  // Card vault feature-request follow-up — deletion is now strictly
  // Admin-only, deliberately narrower than add/edit (which any
  // payments.collect-granted reveal-eligible role can still do). A
  // Ticketing Agent or Manager with the SAME payments.collect grant that
  // already lets them add/edit a card could previously also remove one —
  // that capability is intentionally removed by this pass.
  it.each(["MANAGER", "TICKETING_AGENT"] as const)(
    "denies removal for a %s even with payments.collect — deletion is Admin-only now",
    async (role) => {
      seedContactCard();
      currentActor = { id: "actor-1", role, status: "ACTIVE", paymentPermissions: ["payments.collect"] };
      const { removePaymentMethod } = await import("../contact-payment-methods");
      await expect(removePaymentMethod("pm-1")).rejects.toThrow(/not authorized/i);
      expect(paymentMethods.get("pm-1")!.status).toBe("ACTIVE"); // unchanged
    }
  );

  it("still allows removal for an Admin", async () => {
    seedContactCard();
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: [] };
    const { removePaymentMethod } = await import("../contact-payment-methods");
    await removePaymentMethod("pm-1");
    expect(paymentMethods.get("pm-1")!.status).toBe("ARCHIVED");
  });

  it("denies removal for a non-existent payment method", async () => {
    const { removePaymentMethod } = await import("../contact-payment-methods");
    await expect(removePaymentMethod("does-not-exist")).rejects.toThrow(/not authorized/i);
  });

  it("audits the removal with only last4, never the PAN", async () => {
    seedContactCard();
    const { removePaymentMethod } = await import("../contact-payment-methods");
    await removePaymentMethod("pm-1");
    const entry = auditLogs.find((a) => a.action === "PAYMENT_METHOD_REMOVED");
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain("4111111111111111");
  });
});
