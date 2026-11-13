import { describe, it, expect } from "vitest";
import { AccountRole } from "@/generated/prisma/client";
import { BULK_SELECTION_MAX, pageSelectionState, selectionSignature, toggleCurrentPage } from "../bulk-selection";
import { canBulkDeleteLeadsAndContacts, canBulkEnrollInSequence, canDeleteLead, canDeleteContact, canManageSequences, canViewContacts, canViewLeads } from "../permissions";

const ROLES = Object.values(AccountRole) as string[];

describe("pageSelectionState / toggleCurrentPage", () => {
  const page = ["a", "b", "c"];
  it("reports none / some / all for the rows on the page", () => {
    expect(pageSelectionState(new Set(), page)).toBe("none");
    expect(pageSelectionState(new Set(["b"]), page)).toBe("some");
    expect(pageSelectionState(new Set(["a", "b", "c"]), page)).toBe("all");
    expect(pageSelectionState(new Set(["x", "y"]), page)).toBe("none"); // rows from other pages do not count
    expect(pageSelectionState(new Set(["a"]), [])).toBe("none");
  });
  it("selects the page, keeping other pages' rows; deselects only this page's rows", () => {
    const sel = new Set(["z1", "z2", "b"]);
    const on = toggleCurrentPage(sel, page);
    expect([...on.next].sort()).toEqual(["a", "b", "c", "z1", "z2"]);
    const off = toggleCurrentPage(on.next, page);
    expect([...off.next].sort()).toEqual(["z1", "z2"]);
  });
  it("does not mutate the set it was given", () => {
    const sel = new Set(["a"]);
    toggleCurrentPage(sel, page);
    expect([...sel]).toEqual(["a"]);
  });
  it("refuses to exceed the limit and adds nothing", () => {
    const sel = new Set(Array.from({ length: BULK_SELECTION_MAX - 1 }, (_, i) => `s${i}`));
    const r = toggleCurrentPage(sel, page);
    expect(r.capped).toBe(true);
    expect(r.next.size).toBe(BULK_SELECTION_MAX - 1);
    expect(toggleCurrentPage(new Set(), Array.from({ length: BULK_SELECTION_MAX }, (_, i) => `p${i}`)).capped).toBe(false);
  });
});

describe("selectionSignature", () => {
  const sig = (qs: string) => selectionSignature(new URLSearchParams(qs));
  it("ignores page and pageSize, nothing else", () => {
    expect(sig("page=3&pageSize=50&status=NEW")).toBe(sig("status=NEW"));
    expect(sig("q=a")).not.toBe(sig("q=b"));
    expect(sig("status=NEW&agent=u1")).toBe(sig("agent=u1&status=NEW")); // order does not matter
    expect(sig("")).toBe("");
    expect(selectionSignature(null)).toBe("");
  });
});

describe("permissions for the bulk actions - every role", () => {
  it("knows the roles", () => {
    expect(ROLES.length).toBeGreaterThanOrEqual(5);
  });

  it("bulk delete is Administrator-only - narrower than the single-record delete, which Managers also have", () => {
    for (const role of ROLES) expect(canBulkDeleteLeadsAndContacts(role as never), role).toBe(role === "ADMIN");
    expect(canDeleteLead("MANAGER")).toBe(true);
    expect(canDeleteContact("MANAGER")).toBe(true);
    expect(canBulkDeleteLeadsAndContacts("MANAGER")).toBe(false);
    expect(canBulkDeleteLeadsAndContacts(undefined)).toBe(false);
  });

  it("bulk enrollment is exactly 'may manage sequences' AND 'has that list' - not Admin-only, and no role gained anything", () => {
    for (const role of ROLES) {
      expect(canBulkEnrollInSequence(role as never, "leads"), `${role} leads`).toBe(canManageSequences(role as never) && canViewLeads(role as never));
      expect(canBulkEnrollInSequence(role as never, "contacts"), `${role} contacts`).toBe(canManageSequences(role as never) && canViewContacts(role as never));
    }
    // the roles that exist today, spelled out
    for (const role of ["ADMIN", "MANAGER", "TRAVEL_AGENT"] as const) {
      expect(canBulkEnrollInSequence(role, "leads")).toBe(true);
      expect(canBulkEnrollInSequence(role, "contacts")).toBe(true);
    }
    for (const role of ["TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const) {
      expect(canBulkEnrollInSequence(role, "leads")).toBe(false);
      expect(canBulkEnrollInSequence(role, "contacts")).toBe(false);
    }
    expect(canBulkEnrollInSequence(undefined, "leads")).toBe(false);
  });
});
