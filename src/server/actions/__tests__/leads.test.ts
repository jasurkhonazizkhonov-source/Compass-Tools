import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory fake Prisma, same convention as other server-action test files
// in this project. createLead's contactId branch also calls
// addContactPhone/addContactEmail from contacts.ts directly (not mocked —
// they run for real against this same fake prisma client), so this
// exercises the actual "add as secondary, never overwrite" logic end to end.

type FakeAccount = { id: string; role: string };
type FakeContact = { id: string; firstName: string; lastName: string; primaryPhone: string | null; primaryEmail: string | null; ownerId: string | null };
type FakeContactPhone = { id: string; contactId: string; number: string; type: string; isPrimary: boolean };
type FakeContactEmail = { id: string; contactId: string; email: string; type: string; isPrimary: boolean };
type FakeLead = { id: string; contactId: string; assignedAgentId: string | null; status: string; source: string; priority: string; referredByContactId: string | null };

const AGENT_NAMES: Record<string, string> = { "admin-1": "Sarah Mitchell", "agent-owner": "Jane Owner", "agent-1": "Current Agent" };

let currentActor: FakeAccount | null;
let contacts: Map<string, FakeContact>;
let contactPhones: Map<string, FakeContactPhone>;
let contactEmails: Map<string, FakeContactEmail>;
let leads: Map<string, FakeLead>;
let nextId = 1;

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/activity-log", () => ({
  logActivity: vi.fn(async () => {}),
}));

vi.mock("@/server/actions/lead-queue", () => ({
  distributeNewWebsiteLead: vi.fn(async () => ({ ok: true })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakePrismaClient: any = {
  contact: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; OR?: Array<Record<string, unknown>> } }) => {
        // assertContactAccess's IDOR guard (contacts.ts) looks up by a bare
        // id plus a visibility fragment (ownerId/companyId) this fake
        // doesn't model — every test in this file runs as an ADMIN actor
        // (full company-wide access), so a plain id lookup is equivalent.
        if (where.id !== undefined && !where.OR) {
          return contacts.get(where.id) ?? null;
        }
        // Email conditions may be a plain string OR a Prisma
        // {equals, mode: "insensitive"} filter object (see
        // lib/contact-matching.ts) — this extracts the comparable string
        // and whether the comparison should be case-insensitive either way.
        const emailMatch = (value: string | null, cond: unknown): boolean => {
          if (value == null) return false;
          if (typeof cond === "string") return value === cond;
          const filter = cond as { equals?: string; mode?: string };
          if (filter.mode === "insensitive") return value.toLowerCase() === (filter.equals ?? "").toLowerCase();
          return value === filter.equals;
        };
        for (const contact of contacts.values()) {
          const matches = (where.OR ?? []).some((cond) => {
            if ("primaryPhone" in cond) return contact.primaryPhone === cond.primaryPhone;
            if ("primaryEmail" in cond) return emailMatch(contact.primaryEmail, cond.primaryEmail);
            if ("phones" in cond) {
              const target = (cond.phones as { some: { number: string } }).some.number;
              return [...contactPhones.values()].some((p) => p.contactId === contact.id && p.number === target);
            }
            if ("emails" in cond) {
              const target = (cond.emails as { some: { email: unknown } }).some.email;
              return [...contactEmails.values()].some((e) => e.contactId === contact.id && emailMatch(e.email, target));
            }
            return false;
          });
          if (matches) return contact;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<FakeContact> & { phones?: { create: Array<Partial<FakeContactPhone>> } }; emails?: { create: Array<Partial<FakeContactEmail>> } }) => {
        const id = `contact-${nextId++}`;
        const contact: FakeContact = {
          id,
          firstName: data.firstName ?? "",
          lastName: data.lastName ?? "",
          primaryPhone: data.primaryPhone ?? null,
          primaryEmail: data.primaryPhone !== undefined ? (data as { primaryEmail?: string }).primaryEmail ?? null : null,
          ownerId: null,
        };
        contacts.set(id, contact);
        const rawData = data as unknown as { phones?: { create: Array<{ number: string; type: string; isPrimary: boolean }> }; emails?: { create: Array<{ email: string; type: string; isPrimary: boolean }> } };
        if (rawData.phones) {
          for (const p of rawData.phones.create) {
            const pid = `phone-${nextId++}`;
            contactPhones.set(pid, { id: pid, contactId: id, ...p });
          }
        }
        if (rawData.emails) {
          for (const e of rawData.emails.create) {
            const eid = `email-${nextId++}`;
            contactEmails.set(eid, { id: eid, contactId: id, ...e });
          }
        }
        return contact;
      }),
      update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Partial<FakeContact> }) => {
        const contact = contacts.get(id);
        if (!contact) throw new Error("not found");
        Object.assign(contact, data);
        return contact;
      }),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const contact = contacts.get(id);
        if (!contact) return null;
        return { ownerId: contact.ownerId, owner: contact.ownerId ? { fullName: AGENT_NAMES[contact.ownerId] ?? contact.ownerId } : null };
      }),
    },
    contactPhone: {
      findMany: vi.fn(async ({ where: { contactId } }: { where: { contactId: string } }) =>
        [...contactPhones.values()].filter((p) => p.contactId === contactId)
      ),
      findFirst: vi.fn(async ({ where }: { where: { contactId: string; isPrimary?: boolean } }) =>
        [...contactPhones.values()].find((p) => p.contactId === where.contactId && (where.isPrimary === undefined || p.isPrimary === where.isPrimary)) ?? null
      ),
      count: vi.fn(async ({ where: { contactId } }: { where: { contactId: string } }) =>
        [...contactPhones.values()].filter((p) => p.contactId === contactId).length
      ),
      create: vi.fn(async ({ data }: { data: Omit<FakeContactPhone, "id"> }) => {
        const id = `phone-${nextId++}`;
        const phone = { id, ...data };
        contactPhones.set(id, phone);
        return phone;
      }),
      updateMany: vi.fn(async ({ where: { contactId }, data }: { where: { contactId: string }; data: Partial<FakeContactPhone> }) => {
        let count = 0;
        for (const p of contactPhones.values()) {
          if (p.contactId === contactId) {
            Object.assign(p, data);
            count++;
          }
        }
        return { count };
      }),
    },
    contactEmail: {
      findMany: vi.fn(async ({ where: { contactId } }: { where: { contactId: string } }) =>
        [...contactEmails.values()].filter((e) => e.contactId === contactId)
      ),
      findFirst: vi.fn(async ({ where }: { where: { contactId: string; isPrimary?: boolean } }) =>
        [...contactEmails.values()].find((e) => e.contactId === where.contactId && (where.isPrimary === undefined || e.isPrimary === where.isPrimary)) ?? null
      ),
      count: vi.fn(async ({ where: { contactId } }: { where: { contactId: string } }) =>
        [...contactEmails.values()].filter((e) => e.contactId === contactId).length
      ),
      create: vi.fn(async ({ data }: { data: Omit<FakeContactEmail, "id"> }) => {
        const id = `email-${nextId++}`;
        const email = { id, ...data };
        contactEmails.set(id, email);
        return email;
      }),
      updateMany: vi.fn(async ({ where: { contactId }, data }: { where: { contactId: string }; data: Partial<FakeContactEmail> }) => {
        let count = 0;
        for (const e of contactEmails.values()) {
          if (e.contactId === contactId) {
            Object.assign(e, data);
            count++;
          }
        }
        return { count };
      }),
    },
    lead: {
      create: vi.fn(async ({ data }: { data: Partial<FakeLead> }) => {
        const id = `lead-${nextId++}`;
        const lead: FakeLead = {
          id,
          contactId: data.contactId!,
          assignedAgentId: data.assignedAgentId ?? null,
          status: (data.status as string) ?? "ATTEMPTING_TO_CONTACT",
          source: (data.source as string) ?? "WEBSITE",
          priority: (data.priority as string) ?? "MEDIUM",
          referredByContactId: (data as Partial<FakeLead>).referredByContactId ?? null,
        };
        leads.set(id, lead);
        return lead;
      }),
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => leads.get(id) ?? null),
    },
};

// The fake client has no real transactional isolation — the in-memory Maps
// are shared mutable state regardless — but the callback contract matches
// the real prisma.$transaction(fn) shape, which is all resolveContactForNewLead
// needs to run against this fake.
fakePrismaClient.$transaction = vi.fn(async (fn: (tx: typeof fakePrismaClient) => unknown) => fn(fakePrismaClient));

vi.mock("@/lib/prisma", () => ({
  prisma: fakePrismaClient,
}));

beforeEach(() => {
  contacts = new Map();
  contactPhones = new Map();
  contactEmails = new Map();
  leads = new Map();
  nextId = 1;
  currentActor = { id: "admin-1", role: "ADMIN" };
  vi.clearAllMocks();
});

function seedContact(overrides: Partial<FakeContact> = {}) {
  const contact: FakeContact = { id: "contact-1", firstName: "Jane", lastName: "Traveler", primaryPhone: "+14155550100", primaryEmail: "jane@example.com", ownerId: null, ...overrides };
  contacts.set(contact.id, contact);
  // Seeded IDs must not collide with IDs the mock's own create() calls will
  // generate via nextId — otherwise a later create() overwrites the seed
  // entry instead of adding alongside it.
  const phoneId = `phone-${nextId++}`;
  const emailId = `email-${nextId++}`;
  contactPhones.set(phoneId, { id: phoneId, contactId: contact.id, number: contact.primaryPhone!, type: "MOBILE", isPrimary: true });
  contactEmails.set(emailId, { id: emailId, contactId: contact.id, email: contact.primaryEmail!, type: "PERSONAL", isPrimary: true });
  return contact;
}

const BASE_LEAD_INPUT = {
  firstName: "Jane",
  lastName: "Traveler",
  departureAirportId: 1,
  arrivalAirportId: 2,
  departureDate: "2026-06-01",
  returnDate: "2026-06-08",
  tripType: "ROUND_TRIP" as const,
  cabinClass: "ECONOMY" as const,
  adults: 1,
  children: 0,
  infants: 0,
  source: "PHONE" as const,
  priority: "MEDIUM" as const,
};

describe("createLead — pre-selected contact (New Lead for Customer)", () => {
  it("creates the lead under the given contact, never a new/duplicate one", async () => {
    seedContact();
    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, contactId: "contact-1", phone: "+14155550100", email: "jane@example.com" });
    expect(result.contactId).toBe("contact-1");
    expect(contacts.size).toBe(1);
    expect(leads.get(result.leadId)?.contactId).toBe("contact-1");
  });

  it("applies the same ownership rule as the matching flow: a pre-selected contact owned by another agent auto-assigns the lead to them too", async () => {
    seedContact({ ownerId: "agent-owner" });
    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, contactId: "contact-1", phone: "+14155550100", email: "jane@example.com" });
    expect(result.autoAssignedToOwner).toEqual({ id: "agent-owner", name: "Jane Owner" });
    expect(leads.get(result.leadId)?.assignedAgentId).toBe("agent-owner");
    expect(leads.get(result.leadId)?.status).toBe("ACCEPTED");
  });

  it("a second lead for the same contact does not create a second contact — multiple leads per contact", async () => {
    seedContact();
    const { createLead } = await import("../leads");
    await createLead({ ...BASE_LEAD_INPUT, contactId: "contact-1", phone: "+14155550100", email: "jane@example.com" });
    await createLead({ ...BASE_LEAD_INPUT, contactId: "contact-1", phone: "+14155550100", email: "jane@example.com" });
    expect(contacts.size).toBe(1);
    expect([...leads.values()].filter((l) => l.contactId === "contact-1")).toHaveLength(2);
  });

  it("does not add a duplicate phone/email entry when the submitted value matches an existing one", async () => {
    seedContact();
    const { createLead } = await import("../leads");
    await createLead({ ...BASE_LEAD_INPUT, contactId: "contact-1", phone: "+14155550100", email: "jane@example.com" });
    expect([...contactPhones.values()].filter((p) => p.contactId === "contact-1")).toHaveLength(1);
    expect([...contactEmails.values()].filter((e) => e.contactId === "contact-1")).toHaveLength(1);
  });

  it("adds a NEW phone as a secondary entry, never overwriting the existing primary", async () => {
    seedContact();
    const { createLead } = await import("../leads");
    await createLead({ ...BASE_LEAD_INPUT, contactId: "contact-1", phone: "+14155559999", email: "jane@example.com" });

    const phones = [...contactPhones.values()].filter((p) => p.contactId === "contact-1");
    expect(phones).toHaveLength(2);
    expect(phones.some((p) => p.number === "+14155550100" && p.isPrimary)).toBe(true); // original untouched
    expect(phones.some((p) => p.number === "+14155559999" && !p.isPrimary)).toBe(true); // new one added, not primary
    expect(contacts.get("contact-1")!.primaryPhone).toBe("+14155550100"); // primary field itself never changed
  });

  it("adds a NEW email as a secondary entry, never overwriting the existing primary", async () => {
    seedContact();
    const { createLead } = await import("../leads");
    await createLead({ ...BASE_LEAD_INPUT, contactId: "contact-1", phone: "+14155550100", email: "new-address@example.com" });

    const emails = [...contactEmails.values()].filter((e) => e.contactId === "contact-1");
    expect(emails).toHaveLength(2);
    expect(emails.some((e) => e.email === "jane@example.com" && e.isPrimary)).toBe(true);
    expect(emails.some((e) => e.email === "new-address@example.com" && !e.isPrimary)).toBe(true);
    expect(contacts.get("contact-1")!.primaryEmail).toBe("jane@example.com");
  });

  it("the new lead is associated with the contact for both its own detail view and the global leads list (contactId is the persisted link, not frontend-only state)", async () => {
    seedContact();
    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, contactId: "contact-1", phone: "+14155550100", email: "jane@example.com" });
    const persisted = leads.get(result.leadId);
    expect(persisted?.contactId).toBe("contact-1");
  });
});

describe("createLead — contact matching (no pre-selected contact, e.g. global Leads page)", () => {
  it("matches an existing contact by exact phone and reuses it", async () => {
    seedContact({ primaryEmail: null });
    contactEmails.clear();
    const { createLead } = await import("../leads");
    // Email is a required field on createLead now, but a non-matching one
    // here still proves the match came from the phone, not the email.
    const result = await createLead({ ...BASE_LEAD_INPUT, phone: "+14155550100", email: "unrelated@example.com" });
    expect(result.contactId).toBe("contact-1");
    expect(contacts.size).toBe(1);
  });

  it("matches an existing contact by exact email and reuses it", async () => {
    seedContact({ primaryPhone: null });
    contactPhones.clear();
    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, phone: "+14155551234", email: "jane@example.com" });
    expect(result.contactId).toBe("contact-1");
    expect(contacts.size).toBe(1);
  });

  it("contact belongs to the current agent: lead keeps normal assignment/status (not auto-assigned to someone else), defaults to the creator", async () => {
    seedContact({ ownerId: "admin-1" }); // currentActor.id === "admin-1" by default
    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, phone: "+14155550100", email: "jane@example.com" });
    expect(result.autoAssignedToOwner).toBeUndefined();
    expect(leads.get(result.leadId)?.status).toBe("ATTEMPTING_TO_CONTACT");
    // No explicit assignedAgentId was passed and no contact-owner override
    // applies (the contact's owner IS the current actor) — a manually
    // created lead defaults to whoever created it, never left unassigned.
    expect(leads.get(result.leadId)?.assignedAgentId).toBe("admin-1");
  });

  it("contact belongs to a DIFFERENT agent: lead is assigned to that owner, status becomes ACCEPTED, owner is returned for the UI notification", async () => {
    seedContact({ ownerId: "agent-owner" });
    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, phone: "+14155550100", email: "jane@example.com" });
    expect(result.autoAssignedToOwner).toEqual({ id: "agent-owner", name: "Jane Owner" });
    expect(leads.get(result.leadId)?.assignedAgentId).toBe("agent-owner");
    expect(leads.get(result.leadId)?.status).toBe("ACCEPTED");
  });

  it("no matching contact: normal new-contact creation, no auto-assignment (nothing to match)", async () => {
    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, phone: "+14155559999", email: "brandnew@example.com" });
    expect(result.autoAssignedToOwner).toBeUndefined();
    expect(leads.get(result.leadId)?.status).toBe("ATTEMPTING_TO_CONTACT");
  });

  it("creates a new contact when neither phone nor email matches anything on file", async () => {
    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, phone: "+14155557777", email: "unknown@example.com" });
    expect(contacts.size).toBe(1);
    expect(result.contactId).toBe(contacts.keys().next().value);
  });

  it("retries the transaction and reuses the winning contact when a concurrent submission raced it to a serialization conflict (P2034)", async () => {
    const { Prisma } = await import("@/generated/prisma/client");
    seedContact({ id: "contact-1", primaryPhone: "+14155559999", primaryEmail: "raced@example.com" });
    const realTransaction = fakePrismaClient.$transaction;
    let call = 0;
    fakePrismaClient.$transaction = vi.fn(async (fn: (tx: typeof fakePrismaClient) => unknown) => {
      call++;
      if (call === 1) {
        throw new Prisma.PrismaClientKnownRequestError("Transaction conflict", { code: "P2034", clientVersion: "test" });
      }
      return realTransaction(fn);
    });

    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, phone: "+14155559999", email: "raced@example.com" });

    expect(result.contactId).toBe("contact-1");
    expect(contacts.size).toBe(1);
    expect(fakePrismaClient.$transaction).toHaveBeenCalledTimes(2);
  });
});

describe("createLead — referral (§10-11)", () => {
  it("persists referredByContactId when source is REFERRAL and a referrer is given", async () => {
    seedContact({ id: "contact-1" });
    seedContact({ id: "contact-2", primaryPhone: "+14155552222", primaryEmail: "referrer@example.com" });
    const { createLead } = await import("../leads");
    const result = await createLead({
      ...BASE_LEAD_INPUT,
      contactId: "contact-1",
      phone: "+14155550100",
      email: "jane@example.com",
      source: "REFERRAL",
      referredByContactId: "contact-2",
    });
    expect(leads.get(result.leadId)?.referredByContactId).toBe("contact-2");
  });

  it("drops referredByContactId when source is not REFERRAL, even if one was submitted", async () => {
    seedContact({ id: "contact-1" });
    seedContact({ id: "contact-2" });
    const { createLead } = await import("../leads");
    const result = await createLead({
      ...BASE_LEAD_INPUT,
      contactId: "contact-1",
      phone: "+14155550100",
      email: "jane@example.com",
      source: "PHONE",
      referredByContactId: "contact-2",
    });
    expect(leads.get(result.leadId)?.referredByContactId).toBeNull();
  });

  it("drops a self-referral (referredByContactId === the lead's own contactId) rather than persisting a circular reference", async () => {
    seedContact({ id: "contact-1" });
    const { createLead } = await import("../leads");
    const result = await createLead({
      ...BASE_LEAD_INPUT,
      contactId: "contact-1",
      phone: "+14155550100",
      email: "jane@example.com",
      source: "REFERRAL",
      referredByContactId: "contact-1",
    });
    expect(leads.get(result.leadId)?.referredByContactId).toBeNull();
  });
});

// Pass 6 — server-side phone/email quality gates on createLead. These parse
// via createLeadSchema before any DB call is made, so a direct API request
// that bypasses the frontend (e.g. NewLeadDialog's own client-side checks)
// must still be rejected here. No mocked network/DB state needed — the
// rejection happens at schema.parse() time.
describe("createLead — server-side phone/email validation (independent of frontend)", () => {
  it("rejects an unparseable phone number, even though the frontend would normally have blocked this", async () => {
    const { createLead } = await import("../leads");
    await expect(
      createLead({ ...BASE_LEAD_INPUT, phone: "123", email: "jane@example.com" })
    ).rejects.toThrow();
  });

  it("rejects a syntactically invalid email", async () => {
    const { createLead } = await import("../leads");
    await expect(
      createLead({ ...BASE_LEAD_INPUT, phone: "+14155550100", email: "not-an-email" })
    ).rejects.toThrow();
  });

  it("rejects a phone whose embedded country code conflicts with the explicitly-selected country", async () => {
    const { createLead } = await import("../leads");
    // +44 is a real UK number, but the caller says the selected country was US.
    await expect(
      createLead({ ...BASE_LEAD_INPUT, phone: "+442079460958", phoneCountry: "US", email: "jane@example.com" })
    ).rejects.toThrow(/does not match the selected country/);
  });

  it("accepts a phone whose embedded country code matches the explicitly-selected country", async () => {
    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, phone: "+442079460958", phoneCountry: "GB", email: "jane@example.com" });
    expect(result.leadId).toBeDefined();
  });

  it("does not reject when phoneCountry is omitted entirely (backward compatible — not every caller of this schema sends it)", async () => {
    const { createLead } = await import("../leads");
    const result = await createLead({ ...BASE_LEAD_INPUT, phone: "+442079460958", email: "jane@example.com" });
    expect(result.leadId).toBeDefined();
  });

  it("trims a submitted email before storing it on a brand-new Contact", async () => {
    const { createLead } = await import("../leads");
    await createLead({ ...BASE_LEAD_INPUT, phone: "+14155558888", email: "  spaced@example.com  " });
    const created = [...contacts.values()].find((c) => c.primaryEmail === "spaced@example.com");
    expect(created).toBeDefined();
  });
});
