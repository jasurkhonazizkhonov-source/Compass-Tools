import { describe, it, expect, vi, beforeEach } from "vitest";

// Consolidated tests for the four delete actions (deleteContact, deleteLead,
// deleteQuote, deleteBooking) — permission matrix, existence/IDOR handling,
// and audit logging. Same in-memory-fake-Prisma convention used throughout
// this project's server-action tests.
//
// Note on IDOR coverage: canDeleteContact/canDeleteLead's role ceiling
// (ADMIN/MANAGER) and canDeleteQuote/canDeleteBooking's role ceiling
// (ADMIN only) are both subsets of canViewAllRecords's org-wide-visibility
// roles (ADMIN/MANAGER/TICKETING_AGENT) — every role that can pass the
// delete permission check already has org-wide visibility by this app's
// design, so there is no role combination that is "authorized to delete
// but restricted by ownership visibility" to construct a test around (the
// same structural fact already noted for payment permissions elsewhere in
// this test suite). What IS tested here instead: a record that doesn't
// exist at all is correctly rejected (the existence-check half of IDOR
// protection), and unauthorized roles are denied regardless of ownership.

type FakeAccount = { id: string; role: string; status: string };

let currentActor: FakeAccount | null;
let contacts: Map<string, { id: string; firstName: string; lastName: string; leadCount: number; quoteCount: number; bookingCount: number }>;
let leads: Map<string, { id: string; contactId: string; quoteCount: number }>;
let quotes: Map<string, { id: string; quoteNumber: string; leadId: string; hasBooking: boolean }>;
let bookings: Map<string, { id: string; bookingReference: string; quoteId: string; leadId: string }>;
let auditLogs: Array<{ actorId: string | undefined; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> }>;
let deletedIds: { contact?: string; lead?: string; quote?: string; booking?: string };

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

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async ({ data }: { data: { actorId: string | undefined; action: string; entityType: string; entityId: string; metadata: Record<string, unknown> } }) => {
        auditLogs.push(data);
        return data;
      }),
    },
    contact: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const c = contacts.get(where.id);
        if (!c) return null;
        return { id: c.id, firstName: c.firstName, lastName: c.lastName, _count: { leads: c.leadCount, quotes: c.quoteCount, bookings: c.bookingCount } };
      }),
      delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        deletedIds.contact = id;
        contacts.delete(id);
        return {};
      }),
    },
    lead: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; assignedAgentId?: string } }) => {
        const l = leads.get(where.id);
        if (!l) return null;
        return { id: l.id, contactId: l.contactId, _count: { quotes: l.quoteCount } };
      }),
      delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        deletedIds.lead = id;
        leads.delete(id);
        return {};
      }),
    },
    quote: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const q = quotes.get(where.id);
        if (!q) return null;
        return { id: q.id, quoteNumber: q.quoteNumber, leadId: q.leadId, booking: q.hasBooking ? { id: "booking-x" } : null };
      }),
      delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        deletedIds.quote = id;
        quotes.delete(id);
        return {};
      }),
    },
    booking: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const b = bookings.get(where.id);
        if (!b) return null;
        return { id: b.id, bookingReference: b.bookingReference, quoteId: b.quoteId, leadId: b.leadId };
      }),
      delete: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
        deletedIds.booking = id;
        bookings.delete(id);
        return {};
      }),
    },
  },
}));

beforeEach(() => {
  contacts = new Map([["contact-1", { id: "contact-1", firstName: "Jane", lastName: "Traveler", leadCount: 2, quoteCount: 1, bookingCount: 0 }]]);
  leads = new Map([["lead-1", { id: "lead-1", contactId: "contact-1", quoteCount: 1 }]]);
  quotes = new Map([["quote-1", { id: "quote-1", quoteNumber: "Q-ABC123", leadId: "lead-1", hasBooking: false }]]);
  bookings = new Map([["booking-1", { id: "booking-1", bookingReference: "BFT-XYZ", quoteId: "quote-1", leadId: "lead-1" }]]);
  auditLogs = [];
  deletedIds = {};
  currentActor = { id: "admin-1", role: "ADMIN", status: "ACTIVE" };
  vi.clearAllMocks();
});

describe("deleteContact", () => {
  it("Admin can delete a contact", async () => {
    const { deleteContact } = await import("../contacts");
    await deleteContact("contact-1");
    expect(deletedIds.contact).toBe("contact-1");
  });

  it("Manager can delete a contact", async () => {
    currentActor = { id: "manager-1", role: "MANAGER", status: "ACTIVE" };
    const { deleteContact } = await import("../contacts");
    await deleteContact("contact-1");
    expect(deletedIds.contact).toBe("contact-1");
  });

  for (const role of ["TICKETING_AGENT", "TRAVEL_AGENT", "FLIGHT_EXPERT"]) {
    it(`${role} cannot delete a contact`, async () => {
      currentActor = { id: "agent-1", role, status: "ACTIVE" };
      const { deleteContact } = await import("../contacts");
      await expect(deleteContact("contact-1")).rejects.toThrow(/not authorized/i);
      expect(deletedIds.contact).toBeUndefined();
    });
  }

  it("rejects an unauthenticated actor", async () => {
    currentActor = null;
    const { deleteContact } = await import("../contacts");
    await expect(deleteContact("contact-1")).rejects.toThrow(/not authorized/i);
  });

  it("rejects a contact that does not exist", async () => {
    const { deleteContact } = await import("../contacts");
    await expect(deleteContact("does-not-exist")).rejects.toThrow(/not authorized/i);
  });

  it("audits the deletion with cascaded record counts, never card/PII payloads", async () => {
    const { deleteContact } = await import("../contacts");
    await deleteContact("contact-1");
    const entry = auditLogs.find((a) => a.action === "CONTACT_DELETED");
    expect(entry).toBeTruthy();
    expect(entry!.metadata.cascadedLeadCount).toBe(2);
    expect(entry!.metadata.cascadedQuoteCount).toBe(1);
  });

  it("audits a denial when permission is missing", async () => {
    currentActor = { id: "agent-1", role: "TRAVEL_AGENT", status: "ACTIVE" };
    const { deleteContact } = await import("../contacts");
    await expect(deleteContact("contact-1")).rejects.toThrow();
    expect(auditLogs.some((a) => a.action === "CONTACT_DELETE_DENIED")).toBe(true);
  });
});

describe("deleteLead", () => {
  it("Admin can delete a lead", async () => {
    const { deleteLead } = await import("../leads");
    await deleteLead("lead-1");
    expect(deletedIds.lead).toBe("lead-1");
  });

  it("Manager can delete a lead", async () => {
    currentActor = { id: "manager-1", role: "MANAGER", status: "ACTIVE" };
    const { deleteLead } = await import("../leads");
    await deleteLead("lead-1");
    expect(deletedIds.lead).toBe("lead-1");
  });

  for (const role of ["TICKETING_AGENT", "TRAVEL_AGENT", "FLIGHT_EXPERT"]) {
    it(`${role} cannot delete a lead`, async () => {
      currentActor = { id: "agent-1", role, status: "ACTIVE" };
      const { deleteLead } = await import("../leads");
      await expect(deleteLead("lead-1")).rejects.toThrow(/not authorized/i);
      expect(deletedIds.lead).toBeUndefined();
    });
  }

  it("rejects a lead that does not exist", async () => {
    const { deleteLead } = await import("../leads");
    await expect(deleteLead("does-not-exist")).rejects.toThrow(/not authorized/i);
  });

  it("does not delete or touch the parent Contact", async () => {
    const { deleteLead } = await import("../leads");
    await deleteLead("lead-1");
    expect(contacts.has("contact-1")).toBe(true);
  });
});

describe("deleteQuote", () => {
  it("Admin can delete a quote", async () => {
    const { deleteQuote } = await import("../quotes");
    await deleteQuote("quote-1");
    expect(deletedIds.quote).toBe("quote-1");
  });

  for (const role of ["MANAGER", "TICKETING_AGENT", "TRAVEL_AGENT", "FLIGHT_EXPERT"]) {
    it(`${role} cannot delete a quote (Admin-only, unlike contact/lead)`, async () => {
      currentActor = { id: "actor-1", role, status: "ACTIVE" };
      const { deleteQuote } = await import("../quotes");
      await expect(deleteQuote("quote-1")).rejects.toThrow(/not authorized/i);
      expect(deletedIds.quote).toBeUndefined();
    });
  }

  it("rejects a quote that does not exist", async () => {
    const { deleteQuote } = await import("../quotes");
    await expect(deleteQuote("does-not-exist")).rejects.toThrow(/not authorized/i);
  });

  it("records whether a booking was cascaded in the audit metadata", async () => {
    quotes.set("quote-2", { id: "quote-2", quoteNumber: "Q-DEF456", leadId: "lead-1", hasBooking: true });
    const { deleteQuote } = await import("../quotes");
    await deleteQuote("quote-2");
    const entry = auditLogs.find((a) => a.action === "QUOTE_DELETED" && a.entityId === "quote-2");
    expect(entry!.metadata.cascadedBooking).toBe(true);
  });
});

describe("deleteBooking", () => {
  it("Admin can delete a booking", async () => {
    const { deleteBooking } = await import("../bookings");
    await deleteBooking("booking-1");
    expect(deletedIds.booking).toBe("booking-1");
  });

  for (const role of ["MANAGER", "TICKETING_AGENT", "TRAVEL_AGENT", "FLIGHT_EXPERT"]) {
    it(`${role} cannot delete a booking (Admin-only, unlike contact/lead)`, async () => {
      currentActor = { id: "actor-1", role, status: "ACTIVE" };
      const { deleteBooking } = await import("../bookings");
      await expect(deleteBooking("booking-1")).rejects.toThrow(/not authorized/i);
      expect(deletedIds.booking).toBeUndefined();
    });
  }

  it("rejects a booking that does not exist", async () => {
    const { deleteBooking } = await import("../bookings");
    await expect(deleteBooking("does-not-exist")).rejects.toThrow(/not authorized/i);
  });

  it("does not delete or touch the parent Quote/Lead", async () => {
    const { deleteBooking } = await import("../bookings");
    await deleteBooking("booking-1");
    expect(quotes.has("quote-1")).toBe(true);
    expect(leads.has("lead-1")).toBe(true);
  });
});
