import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakePaymentProvider } from "@/test/fake-payment-provider";

// Adding / editing / removing a saved card from the Contact page. The card is
// captured by the payment provider's hosted fields; this action layer only
// ever handles opaque references + brand/last4/expiry. These tests prove the
// authorization matrix, the IDOR boundary, that nothing card-shaped is stored
// or audited, and that removal detaches the credential at the provider first.

type FakeAccount = { id: string; role: string; status: string; paymentPermissions: string[]; companyId?: string };
type FakeContact = { id: string; ownerId?: string; companyId?: string; providerCustomerId?: string | null };
type FakePaymentMethod = Record<string, unknown> & { id: string; bookingId: string | null; contactId: string | null; last4: string; status: string; vaultStatus: string; providerPaymentMethodId: string | null };

let currentActor: FakeAccount | null;
let contacts: Map<string, FakeContact>;
let paymentMethods: Map<string, FakePaymentMethod>;
let auditLogs: Array<{ actorId: string | undefined; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> }>;
let fake: FakePaymentProvider | null;
let verifyResult: Awaited<ReturnType<typeof import("@/server/payments/vaulted-methods").verifyVaultedSetup>>;
let nextId = 1;

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Map()) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/system/health-events", () => ({ recordHealthEvent: vi.fn(async () => ({ recorded: true, isNew: true })) }));
vi.mock("@/server/payments/provider", async (orig) => ({ ...(await orig<typeof import("@/server/payments/provider")>()), getPaymentProvider: vi.fn(() => fake) }));
vi.mock("@/server/payments/vaulted-methods", () => ({
  getOrCreateProviderCustomer: vi.fn(async () => "cus_contact"),
  verifyVaultedSetup: vi.fn(async () => verifyResult),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async ({ data }: { data: (typeof auditLogs)[number] }) => {
        auditLogs.push(data);
        return data;
      }),
    },
    contact: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = contacts.get(where.id as string);
        if (!row) return null;
        if (where.ownerId !== undefined && row.ownerId !== where.ownerId) return null;
        if (where.companyId !== undefined && row.companyId !== where.companyId) return null;
        return { id: row.id, providerCustomerId: row.providerCustomerId ?? null };
      }),
    },
    paymentMethod: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const pm = { id: `pm-${nextId++}`, status: "ACTIVE", bookingId: null, contactId: null, last4: "", vaultStatus: "NOT_VAULTED", providerPaymentMethodId: null, ...data } as FakePaymentMethod;
        paymentMethods.set(pm.id, pm);
        return pm;
      }),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => paymentMethods.get(id) ?? null),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const pm = paymentMethods.get(id);
        if (!pm) throw new Error("not found");
        Object.assign(pm, data);
        return pm;
      }),
    },
  },
}));

const OK_VERIFY = {
  ok: true as const,
  method: {
    provider: "stripe",
    providerCustomerId: "cus_contact",
    providerPaymentMethodId: "pm_abc123",
    providerSetupIntentId: "seti_abc123",
    cardBrand: "Visa",
    last4: "4242",
    expiryMonth: 8,
    expiryYear: new Date().getUTCFullYear() + 3,
    cardFunding: "credit",
    providerCardholderName: "Jane Traveler",
  },
};

beforeEach(() => {
  contacts = new Map();
  paymentMethods = new Map();
  auditLogs = [];
  nextId = 1;
  fake = new FakePaymentProvider();
  verifyResult = OK_VERIFY;
  currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: [] };
  vi.clearAllMocks();
});

const SAVE = { contactId: "contact-1", setupIntentId: "seti_abc123", cardholderName: "Jane Traveler" };
const SETUP = { contactId: "contact-1", slotKey: "slot-key-00001" };

describe("authorization — who may add a card to a contact", () => {
  const ROLE_CASES: Array<{ role: string; eligible: boolean }> = [
    { role: "ADMIN", eligible: true },
    { role: "MANAGER", eligible: true },
    { role: "TICKETING_AGENT", eligible: true },
    { role: "TRAVEL_AGENT", eligible: false },
    { role: "FLIGHT_EXPERT", eligible: false },
  ];

  for (const { role, eligible } of ROLE_CASES) {
    it(`${role} with payments.collect -> ${eligible ? "allowed" : "denied"} (both steps)`, async () => {
      contacts.set("contact-1", { id: "contact-1" });
      currentActor = { id: "actor-1", role, status: "ACTIVE", paymentPermissions: ["payments.collect"] };
      const { createContactPaymentSetup, saveContactPaymentMethod } = await import("../contact-payment-methods");
      if (eligible) {
        expect((await createContactPaymentSetup(SETUP)).ok).toBe(true);
        expect((await saveContactPaymentMethod(SAVE)).last4).toBe("4242");
      } else {
        await expect(createContactPaymentSetup(SETUP)).rejects.toThrow(/not authorized/i);
        await expect(saveContactPaymentMethod(SAVE)).rejects.toThrow(/not authorized/i);
      }
    });
  }

  it("a non-Admin without the payments.collect grant is denied even with an eligible role", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    currentActor = { id: "manager-1", role: "MANAGER", status: "ACTIVE", paymentPermissions: [] };
    const { saveContactPaymentMethod } = await import("../contact-payment-methods");
    await expect(saveContactPaymentMethod(SAVE)).rejects.toThrow(/not authorized/i);
  });

  it("an INACTIVE account is denied, and so is a signed-out request", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    const { saveContactPaymentMethod } = await import("../contact-payment-methods");
    currentActor = { id: "a", role: "ADMIN", status: "INACTIVE", paymentPermissions: [] };
    await expect(saveContactPaymentMethod(SAVE)).rejects.toThrow(/not authorized/i);
    currentActor = null;
    await expect(saveContactPaymentMethod(SAVE)).rejects.toThrow(/not authorized/i);
  });

  it("IDOR: an eligible role cannot add a card to a contact in ANOTHER company", async () => {
    contacts.set("contact-1", { id: "contact-1", companyId: "other-company" });
    currentActor = { id: "ticketing-1", role: "TICKETING_AGENT", status: "ACTIVE", paymentPermissions: ["payments.collect"], companyId: "my-company" };
    const { createContactPaymentSetup, saveContactPaymentMethod } = await import("../contact-payment-methods");
    await expect(createContactPaymentSetup(SETUP)).rejects.toThrow(/not authorized/i);
    await expect(saveContactPaymentMethod(SAVE)).rejects.toThrow(/not authorized/i);
    expect(paymentMethods.size).toBe(0);
    expect(auditLogs.some((l) => l.action === "PAYMENT_METHOD_MUTATION_DENIED")).toBe(true);
  });

  it("a contact that does not exist is denied", async () => {
    const { saveContactPaymentMethod } = await import("../contact-payment-methods");
    await expect(saveContactPaymentMethod(SAVE)).rejects.toThrow(/not authorized/i);
  });
});

describe("createContactPaymentSetup", () => {
  it("starts a provider capture bound to THIS contact, with a stable idempotency key", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    const { createContactPaymentSetup } = await import("../contact-payment-methods");
    const r = await createContactPaymentSetup(SETUP);
    expect(r.ok).toBe(true);
    const call = fake!.calls.find((c) => c.op === "createSetupSession");
    expect(call?.args).toMatchObject({ metadata: { contactId: "contact-1", purpose: "contact" } });
    // The same slot again returns the same setup — a double click is one capture.
    const again = await createContactPaymentSetup(SETUP);
    expect(again).toEqual(r);
  });

  it("no provider configured => a clear message, never a crash", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    fake = null;
    const { createContactPaymentSetup } = await import("../contact-payment-methods");
    expect(await createContactPaymentSetup(SETUP)).toEqual({ ok: false, error: expect.stringMatching(/no payment provider/i) });
  });

  it("a provider failure returns a friendly message (no provider text) and records an incident", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    const { PaymentProviderError } = await import("@/server/payments/types");
    fake!.failNextSetup = new PaymentProviderError("provider_unavailable", "network_error");
    const { createContactPaymentSetup } = await import("../contact-payment-methods");
    const r = await createContactPaymentSetup(SETUP);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/could not start secure card entry/i) });
    const { recordHealthEvent } = await import("@/server/system/health-events");
    expect(recordHealthEvent).toHaveBeenCalled();
  });
});

describe("saveContactPaymentMethod", () => {
  it("stores the provider vault reference + brand/last4/expiry, attributed to the contact — no card number, no security code", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    const { saveContactPaymentMethod } = await import("../contact-payment-methods");
    const result = await saveContactPaymentMethod(SAVE);
    expect(result).toMatchObject({ last4: "4242", cardBrand: "Visa" });
    const stored = [...paymentMethods.values()][0];
    expect(stored).toMatchObject({
      contactId: "contact-1",
      bookingId: null,
      provider: "stripe",
      providerCustomerId: "cus_contact",
      providerPaymentMethodId: "pm_abc123",
      providerSetupIntentId: "seti_abc123",
      vaultStatus: "VAULTED",
      last4: "4242",
    });
    expect(Object.keys(stored).join(",")).not.toMatch(/encryptedPan|cvv|cvc|pan\b/i);
    expect(stored.amountAllocated).toBeUndefined();
  });

  it("audits with only last4 — never a card number", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    const { saveContactPaymentMethod } = await import("../contact-payment-methods");
    await saveContactPaymentMethod(SAVE);
    const audit = auditLogs.find((l) => l.action === "PAYMENT_METHOD_CREATED")!;
    expect(audit.metadata.last4).toBe("4242");
    expect(JSON.stringify(audit)).not.toMatch(/\d{13,}/);
  });

  it("an unverifiable / incomplete / mismatched capture is refused with the generic message and stores nothing", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    const { saveContactPaymentMethod } = await import("../contact-payment-methods");
    for (const reason of ["not_completed", "mismatch", "invalid_card", "already_used"] as const) {
      verifyResult = { ok: false, reason };
      await expect(saveContactPaymentMethod(SAVE)).rejects.toThrow(/could not be processed/i);
    }
    expect(paymentMethods.size).toBe(0);
  });

  it("the provider being unreachable is reported as such (nothing saved)", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    verifyResult = { ok: false, reason: "provider_unavailable" };
    const { saveContactPaymentMethod } = await import("../contact-payment-methods");
    await expect(saveContactPaymentMethod(SAVE)).rejects.toThrow(/could not be reached/i);
    expect(paymentMethods.size).toBe(0);
  });

  it("rejects malformed input before doing anything", async () => {
    contacts.set("contact-1", { id: "contact-1" });
    const { saveContactPaymentMethod } = await import("../contact-payment-methods");
    await expect(saveContactPaymentMethod({ ...SAVE, cardholderName: "   " })).rejects.toThrow();
    await expect(saveContactPaymentMethod({ ...SAVE, setupIntentId: "x" })).rejects.toThrow();
  });
});

describe("editPaymentMethod — name only", () => {
  function seed(over: Partial<FakePaymentMethod> = {}) {
    contacts.set("contact-1", { id: "contact-1" });
    const pm = { id: "pm-x", bookingId: null, contactId: "contact-1", last4: "4242", status: "ACTIVE", vaultStatus: "VAULTED", providerPaymentMethodId: "pm_abc", cardholderName: "Old Name", ...over } as FakePaymentMethod;
    paymentMethods.set(pm.id, pm);
    return pm;
  }

  it("updates the cardholder name and nothing else", async () => {
    const pm = seed();
    const { editPaymentMethod } = await import("../contact-payment-methods");
    await editPaymentMethod({ paymentMethodId: pm.id, cardholderName: "New Name" });
    expect(pm.cardholderName).toBe("New Name");
    expect(pm.last4).toBe("4242");
    expect(pm.providerPaymentMethodId).toBe("pm_abc");
  });

  it("ignores any attempt to smuggle in card fields (only the name is accepted)", async () => {
    const pm = seed();
    const { editPaymentMethod } = await import("../contact-payment-methods");
    await editPaymentMethod({ paymentMethodId: pm.id, cardholderName: "New Name", cardNumber: "4111111111111111", expiryMonth: 1, expiryYear: 2099, last4: "9999" } as never);
    expect(pm.last4).toBe("4242");
    expect(JSON.stringify(pm)).not.toContain("4111111111111111");
  });

  it("denies a non-eligible role and a non-existent payment method", async () => {
    const pm = seed();
    const { editPaymentMethod } = await import("../contact-payment-methods");
    currentActor = { id: "t", role: "TRAVEL_AGENT", status: "ACTIVE", paymentPermissions: ["payments.collect"] };
    await expect(editPaymentMethod({ paymentMethodId: pm.id, cardholderName: "X" })).rejects.toThrow(/not authorized/i);
    currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE", paymentPermissions: [] };
    await expect(editPaymentMethod({ paymentMethodId: "missing", cardholderName: "X" })).rejects.toThrow(/not authorized/i);
  });
});

describe("removePaymentMethod", () => {
  function seed(over: Partial<FakePaymentMethod> = {}) {
    contacts.set("contact-1", { id: "contact-1" });
    const pm = { id: "pm-x", bookingId: null, contactId: "contact-1", last4: "4242", status: "ACTIVE", vaultStatus: "VAULTED", providerPaymentMethodId: "pm_abc", ...over } as FakePaymentMethod;
    paymentMethods.set(pm.id, pm);
    return pm;
  }

  it("detaches the credential at the provider FIRST, then soft-deletes (ARCHIVED + DETACHED) — never a hard delete", async () => {
    const pm = seed();
    const { removePaymentMethod } = await import("../contact-payment-methods");
    await removePaymentMethod(pm.id);
    expect(fake!.detached.has("pm_abc")).toBe(true);
    expect(pm.status).toBe("ARCHIVED");
    expect(pm.vaultStatus).toBe("DETACHED");
    expect(paymentMethods.has(pm.id)).toBe(true);
  });

  it("if the provider cannot detach it, NOTHING changes locally (never show 'removed' while it stays chargeable)", async () => {
    const pm = seed();
    fake!.detachPaymentMethod = async () => {
      throw new Error("provider down");
    };
    const { removePaymentMethod } = await import("../contact-payment-methods");
    await expect(removePaymentMethod(pm.id)).rejects.toThrow(/nothing was changed/i);
    expect(pm.status).toBe("ACTIVE");
    expect(pm.vaultStatus).toBe("VAULTED");
  });

  it("no provider configured while the card is vaulted => refused with an explanation", async () => {
    const pm = seed();
    fake = null;
    const { removePaymentMethod } = await import("../contact-payment-methods");
    await expect(removePaymentMethod(pm.id)).rejects.toThrow(/isn't available/i);
    expect(pm.status).toBe("ACTIVE");
  });

  it("a legacy (never-vaulted) record is archived without contacting any provider", async () => {
    const pm = seed({ vaultStatus: "NOT_VAULTED", providerPaymentMethodId: null });
    fake = null;
    const { removePaymentMethod } = await import("../contact-payment-methods");
    await removePaymentMethod(pm.id);
    expect(pm.status).toBe("ARCHIVED");
    expect(pm.vaultStatus).toBe("NOT_VAULTED");
  });

  it("only an Admin may remove; other roles are denied and audited", async () => {
    const pm = seed();
    const { removePaymentMethod } = await import("../contact-payment-methods");
    for (const role of ["MANAGER", "TICKETING_AGENT", "TRAVEL_AGENT"]) {
      currentActor = { id: "x", role, status: "ACTIVE", paymentPermissions: ["payments.collect", "payments.manage"] };
      await expect(removePaymentMethod(pm.id)).rejects.toThrow(/not authorized/i);
    }
    expect(pm.status).toBe("ACTIVE");
    expect(auditLogs.filter((l) => l.action === "PAYMENT_METHOD_MUTATION_DENIED").length).toBeGreaterThan(0);
  });

  it("denies removal of a non-existent payment method, and audits a real removal with only last4", async () => {
    const pm = seed();
    const { removePaymentMethod } = await import("../contact-payment-methods");
    await expect(removePaymentMethod("missing")).rejects.toThrow(/not authorized/i);
    await removePaymentMethod(pm.id);
    const audit = auditLogs.find((l) => l.action === "PAYMENT_METHOD_REMOVED")!;
    expect(audit.metadata.last4).toBe("4242");
    expect(JSON.stringify(audit)).not.toMatch(/\d{13,}/);
  });
});
