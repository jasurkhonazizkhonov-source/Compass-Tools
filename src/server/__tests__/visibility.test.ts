import { describe, it, expect } from "vitest";
import { contactVisibilityWhere, leadVisibilityWhere, quoteVisibilityWhere, bookingVisibilityWhere } from "../visibility";
import { canViewAllRecords } from "@/lib/permissions";
import type { AccountRole } from "@/generated/prisma/client";

const ALL_ROLES: AccountRole[] = ["ADMIN", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MANAGER"];
const UNRESTRICTED: AccountRole[] = ["ADMIN", "MANAGER", "TICKETING_AGENT"];
const RESTRICTED: AccountRole[] = ["TRAVEL_AGENT", "FLIGHT_EXPERT"];

describe("canViewAllRecords", () => {
  it("grants full visibility to ADMIN, MANAGER, and TICKETING_AGENT", () => {
    for (const role of UNRESTRICTED) expect(canViewAllRecords(role)).toBe(true);
  });

  it("restricts TRAVEL_AGENT and FLIGHT_EXPERT to their own records", () => {
    for (const role of RESTRICTED) expect(canViewAllRecords(role)).toBe(false);
  });

  it("treats an undefined role as restricted", () => {
    expect(canViewAllRecords(undefined)).toBe(false);
  });
});

const COMPANY = "company-1";

describe("contactVisibilityWhere", () => {
  it("scopes a full-visibility role to its own company, not literally every row", () => {
    for (const role of UNRESTRICTED) {
      expect(contactVisibilityWhere({ id: "acct-1", role, companyId: COMPANY })).toEqual({ companyId: COMPANY });
    }
  });

  it("scopes to ownerId for a restricted role", () => {
    expect(contactVisibilityWhere({ id: "acct-2", role: "TRAVEL_AGENT", companyId: COMPANY })).toEqual({ ownerId: "acct-2" });
  });

  it("fails closed (matches nothing) when there is no viewer at all", () => {
    const where = contactVisibilityWhere(null);
    expect(where).not.toEqual({});
    expect(where).toHaveProperty("id");
  });
});

describe("leadVisibilityWhere", () => {
  it("scopes a full-visibility role to its own company via the lead's contact", () => {
    for (const role of UNRESTRICTED) {
      expect(leadVisibilityWhere({ id: "acct-1", role, companyId: COMPANY })).toEqual({ contact: { companyId: COMPANY } });
    }
  });

  it("scopes to assignedAgentId for a restricted role", () => {
    expect(leadVisibilityWhere({ id: "acct-2", role: "FLIGHT_EXPERT", companyId: COMPANY })).toEqual({ assignedAgentId: "acct-2" });
  });

  it("fails closed when there is no viewer", () => {
    expect(leadVisibilityWhere(undefined)).not.toEqual({});
  });
});

describe("quoteVisibilityWhere", () => {
  it("scopes a full-visibility role to its own company via the quote's contact", () => {
    for (const role of UNRESTRICTED) {
      expect(quoteVisibilityWhere({ id: "acct-1", role, companyId: COMPANY })).toEqual({ contact: { companyId: COMPANY } });
    }
  });

  it("scopes to an OR across the quote's own agent, its lead's agent, and its contact's owner", () => {
    const where = quoteVisibilityWhere({ id: "acct-2", role: "TRAVEL_AGENT", companyId: COMPANY });
    expect(where).toEqual({
      OR: [
        { agentId: "acct-2" },
        { lead: { assignedAgentId: "acct-2" } },
        { contact: { ownerId: "acct-2" } },
      ],
    });
  });
});

describe("bookingVisibilityWhere", () => {
  it("scopes a full-visibility role to its own company via the booking's contact", () => {
    for (const role of UNRESTRICTED) {
      expect(bookingVisibilityWhere({ id: "acct-1", role, companyId: COMPANY })).toEqual({ contact: { companyId: COMPANY } });
    }
  });

  it("scopes to an OR across the booking's quote agent, lead agent, and contact owner", () => {
    const where = bookingVisibilityWhere({ id: "acct-2", role: "TRAVEL_AGENT", companyId: COMPANY });
    expect(where).toEqual({
      OR: [
        { quote: { agentId: "acct-2" } },
        { lead: { assignedAgentId: "acct-2" } },
        { contact: { ownerId: "acct-2" } },
      ],
    });
  });
});

describe("company isolation", () => {
  it("two different companies' full-visibility viewers get two different, non-overlapping where clauses", () => {
    const companyA = contactVisibilityWhere({ id: "admin-a", role: "ADMIN", companyId: "company-a" });
    const companyB = contactVisibilityWhere({ id: "admin-b", role: "ADMIN", companyId: "company-b" });
    expect(companyA).not.toEqual(companyB);
  });
});

describe("every role is covered by exactly one visibility bucket", () => {
  it("every AccountRole value is classified as either unrestricted or restricted, with no overlap and no gap", () => {
    expect(new Set([...UNRESTRICTED, ...RESTRICTED])).toEqual(new Set(ALL_ROLES));
    expect(UNRESTRICTED.filter((r) => RESTRICTED.includes(r))).toHaveLength(0);
  });
});

// Pass 7 §5/§37 — the mandatory business scenario: a Contact's owner and a
// Lead's owner are independent, and a restricted viewer's Lead access must
// never be gated by who owns the Lead's CONTACT. leadVisibilityWhere's own
// restricted branch already structurally can't reference contact.ownerId
// (see the "scopes to assignedAgentId" test above) — this block proves
// that holds against the actual §37 dataset shape, not just the where-
// clause's static structure in isolation.
describe("Pass 7 §5/§37 — Lead visibility is independent of Contact ownership", () => {
  type FakeLead = { id: string; contactId: string; assignedAgentId: string };
  const CONTACT_OWNED_BY_A = "contact-1";
  const LEADS: FakeLead[] = [
    { id: "lead-1", contactId: CONTACT_OWNED_BY_A, assignedAgentId: "agent-a" },
    { id: "lead-2", contactId: CONTACT_OWNED_BY_A, assignedAgentId: "agent-b" },
    { id: "lead-3", contactId: CONTACT_OWNED_BY_A, assignedAgentId: "agent-c" },
  ];

  // Applies a leadVisibilityWhere restricted-branch result ({assignedAgentId})
  // against the in-memory dataset above — a minimal stand-in for what
  // Prisma's WHERE would filter, deliberately NOT touching contact.ownerId
  // anywhere in this simulation (matching the real where-clause's own shape).
  function visibleTo(viewerId: string, role: AccountRole) {
    const where = leadVisibilityWhere({ id: viewerId, role, companyId: COMPANY });
    if ("assignedAgentId" in where) return LEADS.filter((l) => l.assignedAgentId === where.assignedAgentId);
    throw new Error("expected restricted role's where clause to key on assignedAgentId");
  }

  it("Agent B can see Lead 2 (their own lead) even though the Contact it belongs to is owned by Agent A", () => {
    const visible = visibleTo("agent-b", "TRAVEL_AGENT");
    expect(visible.map((l) => l.id)).toEqual(["lead-2"]);
  });

  it("Agent C can see Lead 3 (their own lead), independent of both Agent A's contact ownership and Agent B's lead ownership", () => {
    const visible = visibleTo("agent-c", "FLIGHT_EXPERT");
    expect(visible.map((l) => l.id)).toEqual(["lead-3"]);
  });

  it("Agent A (the Contact's owner) does NOT automatically see leads 2 and 3 just by owning the contact they belong to", () => {
    const visible = visibleTo("agent-a", "TRAVEL_AGENT");
    expect(visible.map((l) => l.id)).toEqual(["lead-1"]);
    expect(visible.some((l) => l.id === "lead-2" || l.id === "lead-3")).toBe(false);
  });

  it("a company-wide viewer (ADMIN/MANAGER/TICKETING_AGENT) sees every lead via contact.companyId, never contact.ownerId", () => {
    for (const role of UNRESTRICTED) {
      const where = leadVisibilityWhere({ id: "admin-x", role, companyId: COMPANY });
      expect(where).toEqual({ contact: { companyId: COMPANY } });
      expect(JSON.stringify(where)).not.toContain("ownerId");
    }
  });
});
