import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AccountRole } from "@/generated/prisma/client";

type FakeBooking = { id: string; quoteAgentId?: string; leadAssignedAgentId?: string; contactOwnerId?: string; contactCompanyId?: string };
type FakeContact = { id: string; ownerId?: string; companyId?: string };

let bookings: Map<string, FakeBooking>;
let contacts: Map<string, FakeContact>;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = bookings.get(where.id as string);
        if (!row) return null;
        const contactCond = where.contact as { companyId?: string } | undefined;
        if (contactCond?.companyId !== undefined && row.contactCompanyId !== contactCond.companyId) return null;
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
    },
    contact: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = contacts.get(where.id as string);
        if (!row) return null;
        if (where.ownerId !== undefined && row.ownerId !== where.ownerId) return null;
        if (where.companyId !== undefined && row.companyId !== where.companyId) return null;
        return { id: row.id };
      }),
    },
  },
}));

beforeEach(() => {
  bookings = new Map();
  contacts = new Map();
  vi.clearAllMocks();
});

const COMPANY = "company-1";
const ADMIN: { id: string; role: AccountRole; companyId: string } = { id: "admin-1", role: "ADMIN", companyId: COMPANY }; // canViewAllRecords -> true, company-wide visibility
const RESTRICTED_OWNER: { id: string; role: AccountRole; companyId: string } = { id: "agent-1", role: "TRAVEL_AGENT", companyId: COMPANY }; // restricted-visibility role

describe("canAccessPaymentMethod — booking-attached card", () => {
  it("grants access when the booking is within the actor's visibility", async () => {
    bookings.set("booking-1", { id: "booking-1", quoteAgentId: "agent-1" });
    const { canAccessPaymentMethod } = await import("../payment-method-access");
    const ok = await canAccessPaymentMethod(RESTRICTED_OWNER, { bookingId: "booking-1", contactId: null });
    expect(ok).toBe(true);
  });

  it("denies access when the booking is outside the actor's visibility (IDOR)", async () => {
    bookings.set("booking-1", { id: "booking-1", quoteAgentId: "someone-else" });
    const { canAccessPaymentMethod } = await import("../payment-method-access");
    const ok = await canAccessPaymentMethod(RESTRICTED_OWNER, { bookingId: "booking-1", contactId: null });
    expect(ok).toBe(false);
  });

  it("a company-wide-visibility role can access any booking's card within its own company", async () => {
    bookings.set("booking-1", { id: "booking-1", quoteAgentId: "someone-else", contactCompanyId: COMPANY });
    const { canAccessPaymentMethod } = await import("../payment-method-access");
    const ok = await canAccessPaymentMethod(ADMIN, { bookingId: "booking-1", contactId: null });
    expect(ok).toBe(true);
  });

  it("a company-wide-visibility role is still denied a DIFFERENT company's booking", async () => {
    bookings.set("booking-1", { id: "booking-1", quoteAgentId: "someone-else", contactCompanyId: "other-company" });
    const { canAccessPaymentMethod } = await import("../payment-method-access");
    const ok = await canAccessPaymentMethod(ADMIN, { bookingId: "booking-1", contactId: null });
    expect(ok).toBe(false);
  });
});

describe("canAccessPaymentMethod — Contact-level card (no booking)", () => {
  it("grants access when the contact is within the actor's visibility", async () => {
    contacts.set("contact-1", { id: "contact-1", ownerId: "agent-1" });
    const { canAccessPaymentMethod } = await import("../payment-method-access");
    const ok = await canAccessPaymentMethod(RESTRICTED_OWNER, { bookingId: null, contactId: "contact-1" });
    expect(ok).toBe(true);
  });

  it("denies access when the contact is outside the actor's visibility (IDOR)", async () => {
    contacts.set("contact-1", { id: "contact-1", ownerId: "someone-else" });
    const { canAccessPaymentMethod } = await import("../payment-method-access");
    const ok = await canAccessPaymentMethod(RESTRICTED_OWNER, { bookingId: null, contactId: "contact-1" });
    expect(ok).toBe(false);
  });
});

describe("canAccessPaymentMethod — booking-submitted card (both references set)", () => {
  it("grants access via the booking reference even if the contact reference alone would have been denied", async () => {
    bookings.set("booking-1", { id: "booking-1", quoteAgentId: "agent-1" });
    contacts.set("contact-1", { id: "contact-1", ownerId: "someone-else" });
    const { canAccessPaymentMethod } = await import("../payment-method-access");
    const ok = await canAccessPaymentMethod(RESTRICTED_OWNER, { bookingId: "booking-1", contactId: "contact-1" });
    expect(ok).toBe(true);
  });
});

describe("canAccessPaymentMethod — fail closed", () => {
  it("denies access when neither reference resolves to anything (orphaned row, or a deleted parent)", async () => {
    const { canAccessPaymentMethod } = await import("../payment-method-access");
    const ok = await canAccessPaymentMethod(ADMIN, { bookingId: "does-not-exist", contactId: "also-does-not-exist" });
    expect(ok).toBe(false);
  });

  it("denies access when both bookingId and contactId are null", async () => {
    const { canAccessPaymentMethod } = await import("../payment-method-access");
    const ok = await canAccessPaymentMethod(ADMIN, { bookingId: null, contactId: null });
    expect(ok).toBe(false);
  });

  it("denies access for a missing/unauthenticated actor", async () => {
    bookings.set("booking-1", { id: "booking-1", quoteAgentId: "agent-1" });
    const { canAccessPaymentMethod } = await import("../payment-method-access");
    const ok = await canAccessPaymentMethod(null, { bookingId: "booking-1", contactId: null });
    expect(ok).toBe(false);
  });
});
