import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 25 §29 — previously, deleting whichever phone/email row happened to
// be marked primary left Contact.primaryPhone/primaryEmail null even when
// other numbers/addresses remained on file, until an agent noticed and
// manually promoted a survivor. syncPrimaryPhone/syncPrimaryEmail now
// auto-promote the most recently added remaining row when nothing is left
// marked primary — the same "first one added becomes primary
// automatically" convention addContactPhone/addContactEmail already use,
// just applied on the way out instead of only on the way in.

type FakePhone = { id: string; contactId: string; number: string; isPrimary: boolean; createdAt: Date };
type FakeEmail = { id: string; contactId: string; email: string; isPrimary: boolean; createdAt: Date };

let phones: Map<string, FakePhone>;
let emails: Map<string, FakeEmail>;
let contactPrimaryPhone: string | null;
let contactPrimaryEmail: string | null;

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => ({ id: "agent-1", role: "TRAVEL_AGENT", companyId: "company-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/visibility", () => ({
  contactVisibilityWhere: vi.fn(() => ({})),
  leadVisibilityWhere: vi.fn(() => ({})),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: {
      findFirst: vi.fn(async () => ({ id: "contact-1" })),
      update: vi.fn(async ({ data }: { data: { primaryPhone?: string | null; primaryEmail?: string | null } }) => {
        if ("primaryPhone" in data) contactPrimaryPhone = data.primaryPhone ?? null;
        if ("primaryEmail" in data) contactPrimaryEmail = data.primaryEmail ?? null;
        return {};
      }),
    },
    contactPhone: {
      deleteMany: vi.fn(async ({ where }: { where: { id: string; contactId: string } }) => {
        const row = phones.get(where.id);
        if (row && row.contactId === where.contactId) phones.delete(where.id);
        return { count: 1 };
      }),
      findFirst: vi.fn(async ({ where, orderBy }: { where: { contactId: string; isPrimary?: boolean }; orderBy?: { createdAt: string } }) => {
        let rows = [...phones.values()].filter((p) => p.contactId === where.contactId);
        if (where.isPrimary !== undefined) rows = rows.filter((p) => p.isPrimary === where.isPrimary);
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ?? null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { isPrimary: boolean } }) => {
        const row = phones.get(where.id)!;
        row.isPrimary = data.isPrimary;
        return row;
      }),
    },
    contactEmail: {
      deleteMany: vi.fn(async ({ where }: { where: { id: string; contactId: string } }) => {
        const row = emails.get(where.id);
        if (row && row.contactId === where.contactId) emails.delete(where.id);
        return { count: 1 };
      }),
      findFirst: vi.fn(async ({ where, orderBy }: { where: { contactId: string; isPrimary?: boolean }; orderBy?: { createdAt: string } }) => {
        let rows = [...emails.values()].filter((e) => e.contactId === where.contactId);
        if (where.isPrimary !== undefined) rows = rows.filter((e) => e.isPrimary === where.isPrimary);
        if (orderBy?.createdAt === "desc") rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ?? null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { isPrimary: boolean } }) => {
        const row = emails.get(where.id)!;
        row.isPrimary = data.isPrimary;
        return row;
      }),
    },
  },
}));

beforeEach(() => {
  contactPrimaryPhone = null;
  contactPrimaryEmail = null;
  vi.clearAllMocks();
});

describe("deleteContactPhone — auto-promotes a remaining number when the primary is deleted (Pass 25 §29)", () => {
  it("promotes the most recently added remaining phone to primary", async () => {
    phones = new Map([
      ["p1", { id: "p1", contactId: "contact-1", number: "+15550000001", isPrimary: true, createdAt: new Date("2026-01-01") }],
      ["p2", { id: "p2", contactId: "contact-1", number: "+15550000002", isPrimary: false, createdAt: new Date("2026-02-01") }],
    ]);
    const { deleteContactPhone } = await import("../contacts");
    await deleteContactPhone("contact-1", "p1");

    expect(phones.get("p2")!.isPrimary).toBe(true);
    expect(contactPrimaryPhone).toBe("+15550000002");
  });

  it("leaves Contact.primaryPhone null when the LAST remaining phone is deleted — no fabricated fallback", async () => {
    phones = new Map([["p1", { id: "p1", contactId: "contact-1", number: "+15550000001", isPrimary: true, createdAt: new Date("2026-01-01") }]]);
    const { deleteContactPhone } = await import("../contacts");
    await deleteContactPhone("contact-1", "p1");

    expect(contactPrimaryPhone).toBeNull();
  });

  it("deleting a NON-primary phone never touches the existing primary", async () => {
    phones = new Map([
      ["p1", { id: "p1", contactId: "contact-1", number: "+15550000001", isPrimary: true, createdAt: new Date("2026-01-01") }],
      ["p2", { id: "p2", contactId: "contact-1", number: "+15550000002", isPrimary: false, createdAt: new Date("2026-02-01") }],
    ]);
    const { deleteContactPhone } = await import("../contacts");
    await deleteContactPhone("contact-1", "p2");

    expect(phones.get("p1")!.isPrimary).toBe(true);
    expect(contactPrimaryPhone).toBe("+15550000001");
  });
});

describe("deleteContactEmail — auto-promotes a remaining address when the primary is deleted (Pass 25 §29)", () => {
  it("promotes the most recently added remaining email to primary", async () => {
    emails = new Map([
      ["e1", { id: "e1", contactId: "contact-1", email: "old@example.com", isPrimary: true, createdAt: new Date("2026-01-01") }],
      ["e2", { id: "e2", contactId: "contact-1", email: "new@example.com", isPrimary: false, createdAt: new Date("2026-02-01") }],
    ]);
    const { deleteContactEmail } = await import("../contacts");
    await deleteContactEmail("contact-1", "e1");

    expect(emails.get("e2")!.isPrimary).toBe(true);
    expect(contactPrimaryEmail).toBe("new@example.com");
  });

  it("leaves Contact.primaryEmail null when the LAST remaining email is deleted", async () => {
    emails = new Map([["e1", { id: "e1", contactId: "contact-1", email: "old@example.com", isPrimary: true, createdAt: new Date("2026-01-01") }]]);
    const { deleteContactEmail } = await import("../contacts");
    await deleteContactEmail("contact-1", "e1");

    expect(contactPrimaryEmail).toBeNull();
  });
});
