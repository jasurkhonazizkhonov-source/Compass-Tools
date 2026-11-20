import { describe, it, expect, vi, beforeEach } from "vitest";

// Where a customer's complete email address can and cannot reach a user: the Reveal action, the send actions (recipients by id), global search, the contact / lead
// lists and the task lead-picker. Fake database; the real privacy policy module runs. Nothing leaves the process.

type Actor = { id: string; role: string; companyId: string; fullName: string; email: string; phone: string | null; status: string };
let actor: Actor | null;
let unlimited: Set<string>;
const sent: Array<Record<string, unknown>> = [];
let revealRows: Array<{ userId: string; contactId: string; dayKey: string }>;
let usageRows: Map<string, number>;
let lastWhere: Record<string, unknown> | null;

const CONTACTS = [
  { id: "c1", firstName: "Sarah", lastName: "Wilson", primaryEmail: "sarah.wilson@example.com", primaryPhone: "+14155550101", companyId: "co-1", ownerId: "agent-1" },
  { id: "c2", firstName: "John", lastName: "Smith", primaryEmail: "john.smith@gmail.com", primaryPhone: "+14155550102", companyId: "co-1", ownerId: "agent-2" },
];
const CONTACT_EMAILS = [
  { id: "ce1", contactId: "c1", email: "sarah.wilson@example.com", isPrimary: true, type: "PERSONAL", createdAt: new Date(2026, 0, 1) },
  { id: "ce2", contactId: "c2", email: "john.smith@gmail.com", isPrimary: true, type: "PERSONAL", createdAt: new Date(2026, 0, 2) },
];
let visibleContacts: Set<string>;

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/email/crm-email", () => ({
  sendCrmEmail: vi.fn(async (p: Record<string, unknown>) => {
    sent.push(p);
    return { ok: true };
  }),
  RecipientNotAllowedError: class extends Error {},
}));
vi.mock("@/server/visibility", () => ({
  contactVisibilityWhere: vi.fn(() => ({ __scope: "contact" })),
  leadVisibilityWhere: vi.fn(() => ({ __scope: "lead" })),
  quoteVisibilityWhere: vi.fn(() => ({})),
  bookingVisibilityWhere: vi.fn(() => ({})),
}));
vi.mock("@/server/record-touch", () => ({ touchContactLeads: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/server/contact-reassignment", () => ({ performContactReassignment: vi.fn(), recheckContactOwnershipMatch: vi.fn() }));
vi.mock("@/server/attachments/cleanup", () => ({ storageKeysForLeads: vi.fn(), purgeStorageObjects: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const contactFindMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    lastWhere = where;
    return CONTACTS;
  });
  return {
    prisma: {
      account: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ unlimitedCustomerEmailAccess: unlimited.has(where.id) })) },
      contact: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => (visibleContacts.has(where.id) ? { id: where.id, primaryEmail: CONTACTS.find((c) => c.id === where.id)?.primaryEmail, emails: CONTACT_EMAILS.filter((e) => e.contactId === where.id) } : null)),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => CONTACTS.find((c) => c.id === where.id) ?? null),
        findMany: contactFindMany,
        count: vi.fn(async () => CONTACTS.length),
      },
      contactEmail: {
        findMany: vi.fn(async ({ where }: { where: { contactId: string; id?: { in: string[] } } }) =>
          CONTACT_EMAILS.filter((e) => e.contactId === where.contactId && (!where.id || where.id.in.includes(e.id))).map((e) => ({ id: e.id, email: e.email }))
        ),
      },
      lead: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === "lead-1" ? { id: "lead-1", contactId: "c1", contact: { primaryEmail: CONTACTS[0].primaryEmail, emails: [{ email: CONTACTS[0].primaryEmail }] } } : null)),
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          lastWhere = where;
          return [{ id: "lead-1", contact: CONTACTS[0], departureAirport: null, arrivalAirport: null }];
        }),
      },
      quote: { findMany: vi.fn(async () => []) },
      booking: { findMany: vi.fn(async () => []) },
      customerEmailRevealEvent: {
        findMany: vi.fn(async ({ where }: { where: { userId: string; dayKey: string; contactId: { in: string[] } } }) =>
          revealRows.filter((r) => r.userId === where.userId && r.dayKey === where.dayKey && where.contactId.in.includes(r.contactId)).map((r) => ({ contactId: r.contactId }))
        ),
      },
      customerEmailRevealUsage: {
        findUnique: vi.fn(async ({ where }: { where: { userId_dayKey: { userId: string; dayKey: string } } }) => {
          const c = usageRows.get(`${where.userId_dayKey.userId}|${where.userId_dayKey.dayKey}`);
          return c === undefined ? null : { count: c };
        }),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join("?");
            if (sql.includes("CustomerEmailRevealEvent")) {
              const [id, userId, , contactId, , dayKey] = values as string[];
              if (revealRows.some((r) => r.userId === userId && r.contactId === contactId && r.dayKey === dayKey)) return [];
              revealRows.push({ userId, contactId, dayKey });
              return [{ id }];
            }
            const [userId, dayKey, limit] = values as [string, string, number];
            const key = `${userId}|${dayKey}`;
            const cur = usageRows.get(key) ?? 0;
            if (cur >= limit) return [];
            usageRows.set(key, cur + 1);
            return [{ count: cur + 1 }];
          },
          contactEmail: { findMany: async ({ where }: { where: { contactId: string } }) => CONTACT_EMAILS.filter((e) => e.contactId === where.contactId).map((e) => ({ id: e.id, email: e.email })) },
          contact: { findUnique: async () => null },
          auditLog: { create: async () => ({}) },
        })
      ),
    },
  };
});

const as = (role: string, id = "agent-1"): Actor => ({ id, role, companyId: "co-1", fullName: "Agent", email: "agent@crm.test", phone: null, status: "ACTIVE" });
beforeEach(() => {
  actor = as("TRAVEL_AGENT");
  unlimited = new Set();
  sent.length = 0;
  revealRows = [];
  usageRows = new Map();
  visibleContacts = new Set(["c1"]);
  lastWhere = null;
});

describe("the Reveal action", () => {
  it("requires a signed-in user, a well-formed request and a customer this user may open - and a refusal costs nothing", async () => {
    const { revealContactEmails } = await import("../customer-email");
    actor = null;
    expect(await revealContactEmails("c1")).toMatchObject({ ok: false });
    actor = as("TRAVEL_AGENT");
    expect(await revealContactEmails("")).toMatchObject({ ok: false, error: "Invalid request" });
    expect(await revealContactEmails("x".repeat(100))).toMatchObject({ ok: false });
    expect(await revealContactEmails("c2")).toEqual({ ok: false, error: "Contact not found" }); // not visible to this agent
    expect(revealRows).toHaveLength(0);
    expect(usageRows.size).toBe(0);
  });

  it("succeeds for a visible customer, counts one, and its RESPONSE never contains an address (the page is re-rendered by the server instead)", async () => {
    const { revealContactEmails } = await import("../customer-email");
    const r = await revealContactEmails("c1");
    expect(r).toMatchObject({ ok: true, charged: true, usage: { used: 1, limit: 5 } });
    expect(JSON.stringify(r)).not.toMatch(/@/);
  });

  it("the lead the customer is viewed from is an accepted way to be allowed to reveal (a lead reassigned to this agent)", async () => {
    visibleContacts = new Set();
    const { revealContactEmails } = await import("../customer-email");
    expect(await revealContactEmails("c1", "lead-1")).toMatchObject({ ok: true });
    expect(await revealContactEmails("c1", "lead-unknown")).toEqual({ ok: false, error: "Contact not found" });
  });

  it("an unrestricted user is let through without being counted", async () => {
    unlimited.add("agent-1");
    const { revealContactEmails } = await import("../customer-email");
    expect(await revealContactEmails("c1")).toMatchObject({ ok: true, charged: false });
    expect(usageRows.size).toBe(0);
  });
});

describe("sending: recipients are named by id, never by raw address, for a restricted user", () => {
  it("sendContactEmail with ids resolves the address on the server; the client never supplied it", async () => {
    const { sendContactEmail } = await import("../contacts");
    await sendContactEmail("c1", { recipientIds: ["ce1"], subject: "Hello", body: "Body" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "sarah.wilson@example.com", contactId: "c1" });
  });

  it("a restricted user's raw `to` is refused - it would otherwise be a way to test whether an address is on file", async () => {
    const { sendContactEmail } = await import("../contacts");
    await expect(sendContactEmail("c1", { to: "sarah.wilson@example.com", subject: "Hello", body: "Body" })).rejects.toThrow(/Choose the recipient/);
    await expect(sendContactEmail("c1", { to: "guess@example.com", subject: "Hello", body: "Body" })).rejects.toThrow(/Choose the recipient/);
    expect(sent).toHaveLength(0);
  });

  it("an id belonging to ANOTHER customer is refused, so ids cannot be used to read other customers' addresses", async () => {
    visibleContacts = new Set(["c1", "c2"]);
    const { sendContactEmail } = await import("../contacts");
    await expect(sendContactEmail("c1", { recipientIds: ["ce2"], subject: "Hello", body: "Body" })).rejects.toThrow(/not available/);
    expect(sent).toHaveLength(0);
  });

  it("a user with Unlimited access (or an Administrator) can still use the established raw-address path", async () => {
    unlimited.add("agent-1");
    const { sendContactEmail } = await import("../contacts");
    await sendContactEmail("c1", { to: "sarah.wilson@example.com", subject: "Hello", body: "Body" });
    actor = as("ADMIN", "admin-1");
    await sendContactEmail("c1", { to: "sarah.wilson@example.com", subject: "Hello again", body: "Body" });
    expect(sent.map((s) => s.to)).toEqual(["sarah.wilson@example.com", "sarah.wilson@example.com"]);
  });

  it("sendLeadEmail follows the same rules", async () => {
    const { sendLeadEmail } = await import("../leads");
    await expect(sendLeadEmail("lead-1", { to: "sarah.wilson@example.com", subject: "S", body: "B" })).rejects.toThrow(/Choose the recipient/);
    expect(sent).toHaveLength(0);
  });
});

describe("search and lists", () => {
  it("global search: a restricted user's query is never matched against email text, and the result line shows only the masked address", async () => {
    const { globalSearch } = await import("@/server/queries/global-search");
    const result = await globalSearch("sarah.wil");
    const where = JSON.stringify(lastWhere);
    expect(where).not.toMatch(/primaryEmail/);
    expect(result.contacts[0].sublabel).toBe("s**********n@example.com");
    expect(JSON.stringify(result)).not.toContain("sarah.wilson@example.com");
  });

  it("global search for an Administrator still matches on email and shows the complete address", async () => {
    actor = as("ADMIN", "admin-1");
    const { globalSearch } = await import("@/server/queries/global-search");
    const result = await globalSearch("sarah.wil");
    const calls = (await import("@/lib/prisma")).prisma.contact.findMany as unknown as ReturnType<typeof vi.fn>;
    expect(JSON.stringify(calls.mock.calls.at(-1)![0].where)).toMatch(/primaryEmail/);
    expect(result.contacts[0].sublabel).toBe("sarah.wilson@example.com");
  });

  it("a customer revealed today appears in full in the search line (for the same user only)", async () => {
    const { revealContactEmails } = await import("../customer-email");
    await revealContactEmails("c1");
    const { globalSearch } = await import("@/server/queries/global-search");
    expect((await globalSearch("sarah")).contacts[0].sublabel).toBe("sarah.wilson@example.com");
    actor = as("TRAVEL_AGENT", "agent-2");
    expect((await globalSearch("sarah")).contacts[0].sublabel).toBe("s**********n@example.com");
  });

  it("the Contacts list: no email search term and a masked primaryEmail for a restricted viewer; complete for an unrestricted one", async () => {
    const { getContacts } = await import("@/server/queries/contacts");
    const restricted = await getContacts({ q: "sarah", viewer: { id: "agent-1", role: "TRAVEL_AGENT", companyId: "co-1" } });
    expect(JSON.stringify(lastWhere)).not.toMatch(/primaryEmail/);
    expect(restricted.contacts.map((c) => c.primaryEmail)).toEqual(["s**********n@example.com", "j********h@gmail.com"]);
    const admin = await getContacts({ q: "sarah", viewer: { id: "admin-1", role: "ADMIN", companyId: "co-1" } });
    expect(JSON.stringify(lastWhere)).toMatch(/primaryEmail/);
    expect(admin.contacts.map((c) => c.primaryEmail)).toEqual(["sarah.wilson@example.com", "john.smith@gmail.com"]);
  });

  it("the referral / contact picker returns masked addresses to a restricted viewer", async () => {
    const { searchContacts } = await import("@/server/queries/contacts");
    const rows = await searchContacts("sarah", { id: "agent-1", role: "TRAVEL_AGENT", companyId: "co-1" });
    expect(JSON.stringify(rows)).not.toContain("sarah.wilson@example.com");
    expect(JSON.stringify(lastWhere)).not.toMatch(/primaryEmail/);
  });

  it("the task lead-picker masks the contact's address in both the default list and a search", async () => {
    const { searchLeadsForTaskLink } = await import("@/server/queries/tasks");
    const viewer = { id: "agent-1", role: "TRAVEL_AGENT" as const, companyId: "co-1" };
    for (const q of ["", "sarah"]) {
      const rows = await searchLeadsForTaskLink(q, viewer);
      expect(JSON.stringify(rows)).not.toContain("sarah.wilson@example.com");
    }
    expect(JSON.stringify(lastWhere)).not.toMatch(/primaryEmail/);
  });
});
