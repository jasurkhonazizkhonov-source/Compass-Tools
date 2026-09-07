import { describe, it, expect } from "vitest";
import {
  canDeleteContact,
  canDeleteLead,
  canDeleteQuote,
  canDeleteBooking,
  canRevealPaymentMethod,
  canConfirmPayment,
  canAuthorizeSupplierPayment,
  canManageContactPaymentMethods,
  canDeletePaymentMethod,
  canRevealBookingIp,
  canViewDashboard,
  canViewContacts,
  canViewLeads,
  canViewSequencesPage,
  canViewTasks,
  canViewBookings,
  canViewGetInTouch,
  canViewSubscriptions,
  canViewCommissions,
  canViewSalesboard,
  canViewQuotesPage,
  canBulkImportContacts,
} from "../permissions";
import type { AccountRole } from "@/generated/prisma/client";

const ALL_ROLES: AccountRole[] = ["ADMIN", "MANAGER", "TICKETING_AGENT", "TRAVEL_AGENT", "FLIGHT_EXPERT"];
const EVERY_ROLE: AccountRole[] = ["ADMIN", "MANAGER", "TICKETING_AGENT", "TRAVEL_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"];

// Page/route-visibility matrix — the same predicates proxy.ts's
// ROUTE_GUARDS and sidebar.tsx's NAV_ITEMS both defer to. Documents the
// intended access model in one place and guards against the exact class of
// bug found during the pre-launch audit: /quotes had a sidebar-only
// restriction for Marketing Agent with no matching proxy.ts guard, so a
// direct URL visit reached the (empty, but still unintended) page. Every
// row here should reflect permissions.ts's own doc comments — if a
// predicate's intent changes, this test is meant to be updated deliberately,
// not to silently start failing for an unrelated reason.
describe("page-visibility matrix — every role x every gated route", () => {
  const BACK_OFFICE: AccountRole[] = ["TICKETING_AGENT", "FLIGHT_EXPERT"];

  it("canViewDashboard: everyone except back-office roles and Marketing Agent", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewDashboard(role)).toBe(!BACK_OFFICE.includes(role) && role !== "MARKETING_AGENT");
    }
  });

  it("canViewContacts: everyone except back-office roles and Marketing Agent", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewContacts(role)).toBe(!BACK_OFFICE.includes(role) && role !== "MARKETING_AGENT");
    }
  });

  it("canViewLeads: everyone except back-office roles and Marketing Agent", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewLeads(role)).toBe(!BACK_OFFICE.includes(role) && role !== "MARKETING_AGENT");
    }
  });

  it("canViewSequencesPage: everyone except back-office roles and Marketing Agent", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewSequencesPage(role)).toBe(!BACK_OFFICE.includes(role) && role !== "MARKETING_AGENT");
    }
  });

  it("canViewTasks: everyone except back-office roles and Marketing Agent", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewTasks(role)).toBe(!BACK_OFFICE.includes(role) && role !== "MARKETING_AGENT");
    }
  });

  it("canViewBookings: everyone except Travel Agent and Marketing Agent", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewBookings(role)).toBe(role !== "TRAVEL_AGENT" && role !== "MARKETING_AGENT");
    }
  });

  it("canViewQuotesPage: everyone except Marketing Agent", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewQuotesPage(role)).toBe(role !== "MARKETING_AGENT");
    }
  });

  it("canViewGetInTouch: Admin only", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewGetInTouch(role)).toBe(role === "ADMIN");
    }
  });

  it("canViewSubscriptions: Admin and Marketing Agent only", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewSubscriptions(role)).toBe(role === "ADMIN" || role === "MARKETING_AGENT");
    }
  });

  it("canViewCommissions: Admin, Manager, Travel Agent only", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewCommissions(role)).toBe(role === "ADMIN" || role === "MANAGER" || role === "TRAVEL_AGENT");
    }
  });

  it("canViewSalesboard: Item 5 — open to every authenticated role, denied only for no account at all", () => {
    for (const role of EVERY_ROLE) {
      expect(canViewSalesboard(role)).toBe(true);
    }
    expect(canViewSalesboard(undefined)).toBe(false);
  });

  it("Marketing Agent has no route in common with the back-office/sales-pipeline pages", () => {
    // Explicit statement of the design intent from permissions.ts's own
    // comment: "no CRM sales-pipeline surface at all" for Marketing Agent.
    expect(canViewDashboard("MARKETING_AGENT")).toBe(false);
    expect(canViewContacts("MARKETING_AGENT")).toBe(false);
    expect(canViewLeads("MARKETING_AGENT")).toBe(false);
    expect(canViewSequencesPage("MARKETING_AGENT")).toBe(false);
    expect(canViewTasks("MARKETING_AGENT")).toBe(false);
    expect(canViewBookings("MARKETING_AGENT")).toBe(false);
    expect(canViewQuotesPage("MARKETING_AGENT")).toBe(false);
    expect(canViewCommissions("MARKETING_AGENT")).toBe(false);
    expect(canViewGetInTouch("MARKETING_AGENT")).toBe(false);
    // The two pages Marketing Agent IS meant to reach, plus Salesboard
    // (Item 5 — deliberately opened to every role, Marketing Agent included):
    expect(canViewSubscriptions("MARKETING_AGENT")).toBe(true);
    expect(canViewSalesboard("MARKETING_AGENT")).toBe(true);
  });

  it("an undefined role (no account) is denied every gated route", () => {
    expect(canViewDashboard(undefined)).toBe(false);
    expect(canViewContacts(undefined)).toBe(false);
    expect(canViewLeads(undefined)).toBe(false);
    expect(canViewQuotesPage(undefined)).toBe(false);
    expect(canViewBookings(undefined)).toBe(false);
  });
});

describe("delete permission matrix", () => {
  describe("canDeleteContact", () => {
    it("Admin and Manager can delete contacts; no other role can", () => {
      for (const role of ALL_ROLES) {
        expect(canDeleteContact(role)).toBe(role === "ADMIN" || role === "MANAGER");
      }
    });
    it("an undefined role (no account) cannot delete", () => {
      expect(canDeleteContact(undefined)).toBe(false);
    });
  });

  describe("canDeleteLead", () => {
    it("Admin and Manager can delete leads; no other role can", () => {
      for (const role of ALL_ROLES) {
        expect(canDeleteLead(role)).toBe(role === "ADMIN" || role === "MANAGER");
      }
    });
    it("an undefined role (no account) cannot delete", () => {
      expect(canDeleteLead(undefined)).toBe(false);
    });
  });

  describe("canDeleteQuote", () => {
    it("only Admin can delete quotes — Manager cannot", () => {
      for (const role of ALL_ROLES) {
        expect(canDeleteQuote(role)).toBe(role === "ADMIN");
      }
    });
    it("an undefined role (no account) cannot delete", () => {
      expect(canDeleteQuote(undefined)).toBe(false);
    });
  });

  describe("canDeleteBooking", () => {
    it("only Admin can delete bookings — Manager cannot", () => {
      for (const role of ALL_ROLES) {
        expect(canDeleteBooking(role)).toBe(role === "ADMIN");
      }
    });
    it("an undefined role (no account) cannot delete", () => {
      expect(canDeleteBooking(undefined)).toBe(false);
    });
  });
});

// Every Admin account must have identical effective permissions — role
// alone is sufficient for every payment/booking-security action,
// regardless of that specific account's paymentPermissions/
// bookingPermissions grant array. This is what keeps "Admin A can reveal
// card numbers but Admin B can't" from being possible.
describe("admin permission uniformity — role alone bypasses the grant array", () => {
  const ADMIN_WITH_NO_GRANTS = { role: "ADMIN" as const, paymentPermissions: [], bookingPermissions: [] };
  const MANAGER_WITH_NO_GRANTS = { role: "MANAGER" as const, paymentPermissions: [], bookingPermissions: [] };

  it("canRevealPaymentMethod: Admin is always true regardless of grants; Manager still requires the explicit grant", () => {
    expect(canRevealPaymentMethod(ADMIN_WITH_NO_GRANTS)).toBe(true);
    expect(canRevealPaymentMethod(MANAGER_WITH_NO_GRANTS)).toBe(false);
    expect(canRevealPaymentMethod({ role: "MANAGER", paymentPermissions: ["payments.reveal"] })).toBe(true);
  });

  it("canConfirmPayment: Admin is always true regardless of grants", () => {
    expect(canConfirmPayment(ADMIN_WITH_NO_GRANTS)).toBe(true);
    expect(canConfirmPayment(MANAGER_WITH_NO_GRANTS)).toBe(false);
  });

  it("canAuthorizeSupplierPayment: Admin is always true regardless of grants", () => {
    expect(canAuthorizeSupplierPayment(ADMIN_WITH_NO_GRANTS)).toBe(true);
    expect(canAuthorizeSupplierPayment(MANAGER_WITH_NO_GRANTS)).toBe(false);
  });

  it("canManageContactPaymentMethods: Admin is always true regardless of grants", () => {
    expect(canManageContactPaymentMethods(ADMIN_WITH_NO_GRANTS)).toBe(true);
    expect(canManageContactPaymentMethods(MANAGER_WITH_NO_GRANTS)).toBe(false);
  });

  it("canRevealBookingIp: Admin is always true regardless of grants", () => {
    expect(canRevealBookingIp(ADMIN_WITH_NO_GRANTS)).toBe(true);
    expect(canRevealBookingIp(MANAGER_WITH_NO_GRANTS)).toBe(false);
  });

  it("a role outside the eligible ceiling (e.g. Travel Agent) is still denied even with a grant present", () => {
    expect(canRevealPaymentMethod({ role: "TRAVEL_AGENT", paymentPermissions: ["payments.reveal"] })).toBe(false);
  });

  it("null/undefined account is always denied, even for these bypass checks", () => {
    expect(canRevealPaymentMethod(null)).toBe(false);
    expect(canRevealPaymentMethod(undefined)).toBe(false);
  });

  // Card vault feature-request follow-up.
  it("canDeletePaymentMethod: Admin-only, even a Manager/Ticketing Agent with every other payment grant is denied", () => {
    expect(canDeletePaymentMethod({ role: "ADMIN" })).toBe(true);
    expect(canDeletePaymentMethod({ role: "MANAGER" })).toBe(false);
    expect(canDeletePaymentMethod({ role: "TICKETING_AGENT" })).toBe(false);
    expect(canDeletePaymentMethod(null)).toBe(false);
    expect(canDeletePaymentMethod(undefined)).toBe(false);
  });

});

// Bulk Contact Import (Compass Tools CRM — Improve Bulk Contact Creation,
// Part 1) — Admin and Manager only, every other role denied. This is the
// server-side authorization boundary bulk-contacts.ts's
// assertBulkImportAccess() defers to, and the same predicate proxy.ts's
// /contacts/bulk-import route guard and the sidebar link both use — so
// this one matrix exercises all three enforcement layers' shared source of
// truth at once.
describe("canBulkImportContacts — Admin and Manager only", () => {
  it("allows Admin", () => {
    expect(canBulkImportContacts("ADMIN")).toBe(true);
  });

  it("allows Manager", () => {
    expect(canBulkImportContacts("MANAGER")).toBe(true);
  });

  it("denies Travel Agent", () => {
    expect(canBulkImportContacts("TRAVEL_AGENT")).toBe(false);
  });

  it("denies every other role", () => {
    for (const role of ["TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as AccountRole[]) {
      expect(canBulkImportContacts(role)).toBe(false);
    }
  });

  it("denies an unauthenticated (undefined role) request", () => {
    expect(canBulkImportContacts(undefined)).toBe(false);
  });
});
