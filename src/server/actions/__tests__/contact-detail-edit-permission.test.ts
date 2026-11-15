import { describe, it, expect, vi, beforeEach } from "vitest";

// The per-user "Can edit Lead/Contact phone & email" permission, enforced on the SERVER in every action that writes those fields. The record-access rule
// (assertContactAccess) is mocked as "this contact is visible" so these tests isolate the new rule: whatever the UI shows, a direct call from a user without the
// permission must be refused BEFORE any write, a user with it (and every Administrator) must still succeed, and unrelated edits must be unaffected.

type Actor = { id: string; role: string; companyId: string; canEditContactDetails?: boolean } | null;
let currentActor: Actor;
const writes: string[] = [];
const record = (name: string) => vi.fn(async (...args: unknown[]) => { void args; writes.push(name); return { id: "row-1", count: 1 }; });

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/record-touch", () => ({ touchContactLeads: vi.fn(async () => {}) }));
vi.mock("@/server/visibility", () => ({ contactVisibilityWhere: vi.fn(() => ({})), leadVisibilityWhere: vi.fn(() => ({})) }));
const contactUpdate = record("contact.update");
vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: { findFirst: vi.fn(async () => ({ id: "contact-1" })), update: (...a: unknown[]) => contactUpdate(...a) },
    contactPhone: {
      findFirst: vi.fn(async () => null), count: vi.fn(async () => 0),
      create: record("contactPhone.create"), update: record("contactPhone.update"), updateMany: record("contactPhone.updateMany"), deleteMany: record("contactPhone.deleteMany"),
    },
    contactEmail: {
      findFirst: vi.fn(async () => null), count: vi.fn(async () => 0),
      create: record("contactEmail.create"), update: record("contactEmail.update"), updateMany: record("contactEmail.updateMany"), deleteMany: record("contactEmail.deleteMany"),
    },
  },
}));

beforeEach(() => {
  writes.length = 0;
  contactUpdate.mockClear();
  currentActor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1", canEditContactDetails: true };
});

const DENIED = /do not have permission to edit phone numbers or email addresses/i;

async function calls() {
  const m = await import("../contacts");
  return {
    "updatePrimaryPhoneNumber": () => m.updatePrimaryPhoneNumber("contact-1", "+14155709267"),
    "updatePrimaryEmailAddress": () => m.updatePrimaryEmailAddress("contact-1", "new@example.com"),
    "addContactPhone": () => m.addContactPhone({ contactId: "contact-1", number: "+14155709267", type: "MOBILE", isPrimary: false }),
    "addContactEmail": () => m.addContactEmail({ contactId: "contact-1", email: "new@example.com", type: "PERSONAL", isPrimary: false }),
    "setPrimaryPhone": () => m.setPrimaryPhone("contact-1", "phone-1"),
    "setPrimaryEmail": () => m.setPrimaryEmail("contact-1", "email-1"),
    "deleteContactPhone": () => m.deleteContactPhone("contact-1", "phone-1"),
    "deleteContactEmail": () => m.deleteContactEmail("contact-1", "email-1"),
  } as Record<string, () => Promise<unknown>>;
}

describe("phone / email editing needs the per-user permission", () => {
  it.each(["TRAVEL_AGENT", "MANAGER", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])("%s with the permission switched OFF is refused by every phone/email action, and nothing is written", async (role) => {
    currentActor = { id: "u", role, companyId: "company-1", canEditContactDetails: false };
    for (const [name, call] of Object.entries(await calls())) {
      await expect(call(), name).rejects.toThrow(DENIED);
    }
    expect(writes).toEqual([]);
  });

  it("an account object that does not carry the flag at all is refused too (fails closed, never assumes the default)", async () => {
    currentActor = { id: "u", role: "TRAVEL_AGENT", companyId: "company-1" };
    for (const [name, call] of Object.entries(await calls())) await expect(call(), name).rejects.toThrow(DENIED);
    expect(writes).toEqual([]);
  });

  it("no signed-in user is refused as unauthenticated", async () => {
    currentActor = null;
    for (const [name, call] of Object.entries(await calls())) await expect(call(), name).rejects.toThrow(/not authenticated/i);
    expect(writes).toEqual([]);
  });

  it.each(["TRAVEL_AGENT", "MANAGER", "TICKETING_AGENT"])("%s with the permission ON can still make every phone/email change", async (role) => {
    currentActor = { id: "u", role, companyId: "company-1", canEditContactDetails: true };
    for (const [name, call] of Object.entries(await calls())) await expect(call(), name).resolves.not.toThrow();
    expect(writes.length).toBeGreaterThan(0);
  });

  it("an Administrator can always edit them, whatever the flag says", async () => {
    currentActor = { id: "admin", role: "ADMIN", companyId: "company-1", canEditContactDetails: false };
    for (const [name, call] of Object.entries(await calls())) await expect(call(), name).resolves.not.toThrow();
  });
});

describe("other contact edits are unaffected by the phone/email permission", () => {
  it("a user without it can still edit the contact's name", async () => {
    currentActor = { id: "u", role: "TRAVEL_AGENT", companyId: "company-1", canEditContactDetails: false };
    const { updateContactField } = await import("../contacts");
    await updateContactField("contact-1", { firstName: "Ada", lastName: "Lovelace" });
    expect(contactUpdate).toHaveBeenCalledWith({ where: { id: "contact-1" }, data: { firstName: "Ada", lastName: "Lovelace" } });
  });

  it("updateContactField writes ONLY the name fields: a direct call smuggling email, phone, owner or company is stripped (no bypass of the permission)", async () => {
    currentActor = { id: "u", role: "TRAVEL_AGENT", companyId: "company-1", canEditContactDetails: false };
    const { updateContactField } = await import("../contacts");
    await updateContactField("contact-1", { firstName: "Ada", primaryEmail: "evil@example.com", primaryPhone: "+10000000000", ownerId: "me", companyId: "other" } as never);
    expect(contactUpdate).toHaveBeenCalledTimes(1);
    expect(contactUpdate.mock.calls[0][0]).toEqual({ where: { id: "contact-1" }, data: { firstName: "Ada" } });
  });

  it("a patch with no allowed field writes nothing, and a blank first/last name or a non-string is rejected", async () => {
    const { updateContactField } = await import("../contacts");
    await updateContactField("contact-1", { primaryEmail: "x@example.com" } as never);
    expect(contactUpdate).not.toHaveBeenCalled();
    await expect(updateContactField("contact-1", { firstName: "  " })).rejects.toThrow(/invalid/i);
    await expect(updateContactField("contact-1", { lastName: 5 } as never)).rejects.toThrow(/invalid/i);
    expect(contactUpdate).not.toHaveBeenCalled();
  });
});
