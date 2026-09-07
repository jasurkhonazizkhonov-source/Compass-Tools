import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 34 — real bug found and fixed: globalSearch() previously ran with
// NO visibility scoping at all (no company filter, no ownerId/
// assignedAgentId restriction) — unlike every other list/detail query in
// this codebase, which merges one of visibility.ts's *VisibilityWhere
// helpers into its own query. This suite proves the fix end to end: a
// restricted (non-canViewAllRecords) viewer's search never surfaces a
// record outside their own scope — a different agent's contact/lead/quote
// in the SAME company, or ANY record in a DIFFERENT company — while a
// company-wide viewer (Admin/Manager) still finds every match within their
// own company, and never crosses into another company's data either.

type FakeContact = { id: string; companyId: string; ownerId: string | null; firstName: string; lastName: string; primaryEmail: string | null; primaryPhone: string | null };
type FakeLead = { id: string; contactId: string; assignedAgentId: string | null };
type FakeQuote = { id: string; contactId: string; leadId: string | null; agentId: string | null; quoteNumber: string };
type FakeBooking = { id: string; contactId: string; quoteId: string | null; bookingReference: string; pnr: string | null };
type FakeAccount = { id: string; role: string; companyId: string };

let currentActor: FakeAccount | null;
let contacts: FakeContact[];
let leads: FakeLead[];
let quotes: FakeQuote[];
let bookings: FakeBooking[];

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => currentActor),
}));

// Minimal-but-faithful matcher for the finite set of shapes visibility.ts's
// helpers actually produce, plus the plain `contains`/`OR` text-search
// fragments global-search.ts builds — enough to prove real filtering
// behavior end to end, not just that a where-clause object was constructed.
function textMatch(haystack: string | null | undefined, needle: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(needle.toLowerCase());
}

// visibility.ts's NOTHING_VISIBLE sentinel for a missing/null viewer —
// `{ id: "__no_viewer__" }` — never matches any real row's shape below.
function isNothingVisible(vis: Record<string, unknown>): boolean {
  return vis.id === "__no_viewer__";
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: {
      findMany: vi.fn(async ({ where }: { where: { AND: [Record<string, unknown>, { OR: Record<string, unknown>[] }] } }) => {
        const [vis, textOr] = where.AND;
        return contacts.filter((c) => {
          const visOk = isNothingVisible(vis) ? false : "companyId" in vis ? c.companyId === vis.companyId : c.ownerId === (vis as { ownerId: string }).ownerId;
          if (!visOk) return false;
          return textOr.OR.some((cond) => {
            if ("firstName" in cond) return textMatch(c.firstName, (cond.firstName as { contains: string }).contains);
            if ("lastName" in cond) return textMatch(c.lastName, (cond.lastName as { contains: string }).contains);
            if ("primaryEmail" in cond) return textMatch(c.primaryEmail, (cond.primaryEmail as { contains: string }).contains);
            if ("primaryPhone" in cond) return textMatch(c.primaryPhone, (cond.primaryPhone as { contains: string }).contains);
            return false;
          });
        }).slice(0, 5).map((c) => ({ ...c }));
      }),
    },
    lead: {
      findMany: vi.fn(async ({ where }: { where: { AND: [Record<string, unknown>, { OR: Record<string, unknown>[] }] } }) => {
        const [vis, textOr] = where.AND;
        return leads.filter((l) => {
          const contact = contacts.find((c) => c.id === l.contactId)!;
          const visOk = isNothingVisible(vis) ? false : "contact" in vis ? contact.companyId === (vis as { contact: { companyId: string } }).contact.companyId : l.assignedAgentId === (vis as { assignedAgentId: string }).assignedAgentId;
          if (!visOk) return false;
          return textOr.OR.some((cond) => {
            if ("contact" in cond) {
              const c = cond as { contact: { firstName?: { contains: string }; lastName?: { contains: string } } };
              if (c.contact.firstName) return textMatch(contact.firstName, c.contact.firstName.contains);
              if (c.contact.lastName) return textMatch(contact.lastName, c.contact.lastName.contains);
            }
            return false;
          });
        }).slice(0, 5).map((l) => ({ ...l, contact: contacts.find((c) => c.id === l.contactId), departureAirport: null, arrivalAirport: null }));
      }),
    },
    quote: {
      findMany: vi.fn(async ({ where }: { where: { AND: [Record<string, unknown>, { OR: Record<string, unknown>[] }] } }) => {
        const [vis, textOr] = where.AND;
        return quotes.filter((q) => {
          const contact = contacts.find((c) => c.id === q.contactId)!;
          const lead = leads.find((l) => l.id === q.leadId);
          let visOk: boolean;
          if (isNothingVisible(vis)) visOk = false;
          else if ("contact" in vis) visOk = contact.companyId === (vis as { contact: { companyId: string } }).contact.companyId;
          else {
            const or = (vis as { OR: Record<string, unknown>[] }).OR;
            visOk = or.some((cond) => {
              if ("agentId" in cond) return q.agentId === (cond as { agentId: string }).agentId;
              if ("lead" in cond) return lead?.assignedAgentId === (cond as { lead: { assignedAgentId: string } }).lead.assignedAgentId;
              if ("contact" in cond) return contact.ownerId === (cond as { contact: { ownerId: string } }).contact.ownerId;
              return false;
            });
          }
          if (!visOk) return false;
          return textOr.OR.some((cond) => {
            if ("quoteNumber" in cond) return textMatch(q.quoteNumber, (cond.quoteNumber as { contains: string }).contains);
            if ("contact" in cond) {
              const c = cond as { contact: { firstName?: { contains: string }; lastName?: { contains: string } } };
              if (c.contact.firstName) return textMatch(contact.firstName, c.contact.firstName.contains);
              if (c.contact.lastName) return textMatch(contact.lastName, c.contact.lastName.contains);
            }
            return false;
          });
        }).slice(0, 5).map((q) => ({ ...q, contact: contacts.find((c) => c.id === q.contactId) }));
      }),
    },
    booking: {
      findMany: vi.fn(async ({ where }: { where: { AND: [Record<string, unknown>, { OR: Record<string, unknown>[] }] } }) => {
        const [vis, textOr] = where.AND;
        return bookings.filter((b) => {
          const contact = contacts.find((c) => c.id === b.contactId)!;
          const quote = quotes.find((q) => q.id === b.quoteId);
          const lead = quote ? leads.find((l) => l.id === quote.leadId) : undefined;
          let visOk: boolean;
          if (isNothingVisible(vis)) visOk = false;
          else if ("contact" in vis) visOk = contact.companyId === (vis as { contact: { companyId: string } }).contact.companyId;
          else {
            const or = (vis as { OR: Record<string, unknown>[] }).OR;
            visOk = or.some((cond) => {
              if ("quote" in cond) return quote?.agentId === (cond as { quote: { agentId: string } }).quote.agentId;
              if ("lead" in cond) return lead?.assignedAgentId === (cond as { lead: { assignedAgentId: string } }).lead.assignedAgentId;
              if ("contact" in cond) return contact.ownerId === (cond as { contact: { ownerId: string } }).contact.ownerId;
              return false;
            });
          }
          if (!visOk) return false;
          return textOr.OR.some((cond) => {
            if ("bookingReference" in cond) return textMatch(b.bookingReference, (cond.bookingReference as { contains: string }).contains);
            if ("pnr" in cond) return textMatch(b.pnr, (cond.pnr as { contains: string }).contains);
            if ("contact" in cond) {
              const c = cond as { contact: { firstName?: { contains: string }; lastName?: { contains: string } } };
              if (c.contact.firstName) return textMatch(contact.firstName, c.contact.firstName.contains);
              if (c.contact.lastName) return textMatch(contact.lastName, c.contact.lastName.contains);
            }
            return false;
          });
        }).slice(0, 5).map((b) => ({ ...b, contact: contacts.find((c) => c.id === b.contactId) }));
      }),
    },
  },
}));

beforeEach(() => {
  contacts = [
    { id: "contact-a", companyId: "company-1", ownerId: "agent-a", firstName: "Alice", lastName: "Anderson", primaryEmail: "alice@example.com", primaryPhone: null },
    { id: "contact-b", companyId: "company-1", ownerId: "agent-b", firstName: "Bob", lastName: "Baker", primaryEmail: "bob@example.com", primaryPhone: null },
    { id: "contact-x", companyId: "company-2", ownerId: "agent-x", firstName: "Xander", lastName: "Xin", primaryEmail: "xander@example.com", primaryPhone: null },
  ];
  leads = [
    { id: "lead-a", contactId: "contact-a", assignedAgentId: "agent-a" },
    { id: "lead-b", contactId: "contact-b", assignedAgentId: "agent-b" },
  ];
  quotes = [
    { id: "quote-a", contactId: "contact-a", leadId: "lead-a", agentId: "agent-a", quoteNumber: "Q-AAA" },
    { id: "quote-b", contactId: "contact-b", leadId: "lead-b", agentId: "agent-b", quoteNumber: "Q-BBB" },
  ];
  bookings = [
    { id: "booking-b", contactId: "contact-b", quoteId: "quote-b", bookingReference: "REF-BBB", pnr: null },
  ];
  currentActor = { id: "agent-a", role: "TRAVEL_AGENT", companyId: "company-1" };
  vi.clearAllMocks();
});

describe("globalSearch — visibility scoping (Pass 34 fix)", () => {
  it("a restricted agent's search never returns another agent's contact in the SAME company", async () => {
    const { globalSearch } = await import("../global-search");
    const result = await globalSearch("Baker");
    expect(result.contacts).toHaveLength(0);
  });

  it("a restricted agent's search never returns another agent's lead/quote/booking in the SAME company", async () => {
    const { globalSearch } = await import("../global-search");
    const result = await globalSearch("Bob");
    expect(result.leads).toHaveLength(0);
    expect(result.quotes).toHaveLength(0);
    expect(result.bookings).toHaveLength(0);
  });

  it("a restricted agent's search still finds their OWN contact/lead/quote", async () => {
    const { globalSearch } = await import("../global-search");
    const result = await globalSearch("Alice");
    expect(result.contacts.map((c) => c.id)).toEqual(["contact-a"]);
    expect(result.leads.map((l) => l.id)).toEqual(["lead-a"]);
    expect(result.quotes.map((q) => q.id)).toEqual(["quote-a"]);
  });

  it("no viewer at all (unauthenticated) returns nothing rather than everything", async () => {
    currentActor = null;
    const { globalSearch } = await import("../global-search");
    const result = await globalSearch("Alice");
    expect(result).toEqual({ contacts: [], leads: [], quotes: [], bookings: [] });
  });

  it("a company-wide viewer (Admin) sees every match within their own company", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    const { globalSearch } = await import("../global-search");
    const result = await globalSearch("Baker");
    expect(result.contacts.map((c) => c.id)).toEqual(["contact-b"]);
    const bookingResult = await globalSearch("REF-BBB");
    expect(bookingResult.bookings.map((b) => b.id)).toEqual(["booking-b"]);
  });

  it("a company-wide viewer (Admin) NEVER sees a match belonging to a different company", async () => {
    currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
    const { globalSearch } = await import("../global-search");
    const result = await globalSearch("Xander");
    expect(result.contacts).toHaveLength(0);
  });
});
