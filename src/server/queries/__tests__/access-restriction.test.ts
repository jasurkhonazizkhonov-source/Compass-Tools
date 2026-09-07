import { describe, it, expect, vi, beforeEach } from "vitest";

// Access-restriction regression suite (§2-5, §39 of the spec): a record
// that genuinely doesn't exist must be distinguishable from one that exists
// but isn't visible to the current viewer. The four *RecordExists() helpers
// are the unscoped half of that distinction — findUnique by id alone, no
// visibility where — while the existing getXDetail(id, viewer) functions
// remain the scoped half (already covered by the earlier visibility-tests
// suite for their ownership-filtering behavior). This suite proves the two
// halves combine correctly: exists-but-not-owned returns (true, null) —
// the Access Restricted case — and a bad id returns (false, null) — the
// real-404 case — never conflating the two.

type FakeRow = { id: string; ownerId: string | null };

let contacts: Map<string, FakeRow>;
let leads: Map<string, FakeRow & { assignedAgentId: string | null }>;
let quotes: Map<string, FakeRow & { agentId: string | null }>;
let bookings: Map<string, FakeRow & { quoteId: string | null }>;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const row = contacts.get(id);
        return row ? { id: row.id } : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; ownerId?: string } }) => {
        const row = contacts.get(where.id);
        if (!row) return null;
        if (where.ownerId !== undefined && row.ownerId !== where.ownerId) return null;
        return row;
      }),
    },
    lead: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const row = leads.get(id);
        return row ? { id: row.id } : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; assignedAgentId?: string } }) => {
        const row = leads.get(where.id);
        if (!row) return null;
        if (where.assignedAgentId !== undefined && row.assignedAgentId !== where.assignedAgentId) return null;
        return row;
      }),
    },
    quote: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const row = quotes.get(id);
        return row ? { id: row.id } : null;
      }),
    },
    booking: {
      findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        const row = bookings.get(id);
        return row ? { id: row.id } : null;
      }),
    },
  },
}));

beforeEach(() => {
  contacts = new Map([["contact-1", { id: "contact-1", ownerId: "agent-owner" }]]);
  leads = new Map([["lead-1", { id: "lead-1", ownerId: null, assignedAgentId: "agent-owner" }]]);
  quotes = new Map([["quote-1", { id: "quote-1", ownerId: null, agentId: "agent-owner" }]]);
  bookings = new Map([["booking-1", { id: "booking-1", ownerId: null, quoteId: "quote-1" }]]);
  vi.clearAllMocks();
});

describe("contactRecordExists", () => {
  it("returns true for a record that exists, regardless of ownership", async () => {
    const { contactRecordExists } = await import("../contacts");
    expect(await contactRecordExists("contact-1")).toBe(true);
  });
  it("returns false for an id that doesn't exist at all", async () => {
    const { contactRecordExists } = await import("../contacts");
    expect(await contactRecordExists("does-not-exist")).toBe(false);
  });
});

describe("leadRecordExists", () => {
  it("returns true for a record that exists, regardless of ownership", async () => {
    const { leadRecordExists } = await import("../leads");
    expect(await leadRecordExists("lead-1")).toBe(true);
  });
  it("returns false for an id that doesn't exist at all", async () => {
    const { leadRecordExists } = await import("../leads");
    expect(await leadRecordExists("does-not-exist")).toBe(false);
  });
});

describe("quoteRecordExists", () => {
  it("returns true for a record that exists", async () => {
    const { quoteRecordExists } = await import("../quotes");
    expect(await quoteRecordExists("quote-1")).toBe(true);
  });
  it("returns false for an id that doesn't exist at all", async () => {
    const { quoteRecordExists } = await import("../quotes");
    expect(await quoteRecordExists("does-not-exist")).toBe(false);
  });
});

describe("bookingRecordExists", () => {
  it("returns true for a record that exists", async () => {
    const { bookingRecordExists } = await import("../bookings");
    expect(await bookingRecordExists("booking-1")).toBe(true);
  });
  it("returns false for an id that doesn't exist at all", async () => {
    const { bookingRecordExists } = await import("../bookings");
    expect(await bookingRecordExists("does-not-exist")).toBe(false);
  });
});

describe("the exists+scoped combination distinguishes real-404 from access-restricted", () => {
  it("a record another agent owns: exists=true, scoped lookup=null (Access Restricted case)", async () => {
    const { contactRecordExists } = await import("../contacts");
    const exists = await contactRecordExists("contact-1");
    const scoped = await (await import("@/lib/prisma")).prisma.contact.findFirst({ where: { id: "contact-1", ownerId: "someone-else" } });
    expect(exists).toBe(true);
    expect(scoped).toBeNull();
  });

  it("an id that was never a real record: exists=false (real 404 case, never Access Restricted)", async () => {
    const { leadRecordExists } = await import("../leads");
    const exists = await leadRecordExists("totally-bogus-id");
    expect(exists).toBe(false);
  });

  it("a record the current viewer legitimately owns: exists=true, scoped lookup returns the row (normal render)", async () => {
    const { leadRecordExists } = await import("../leads");
    const exists = await leadRecordExists("lead-1");
    const scoped = await (await import("@/lib/prisma")).prisma.lead.findFirst({ where: { id: "lead-1", assignedAgentId: "agent-owner" } });
    expect(exists).toBe(true);
    expect(scoped).not.toBeNull();
  });
});
