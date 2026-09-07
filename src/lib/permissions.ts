import type { AccountRole } from "@/generated/prisma/client";

// Future-ready permission layer. Authentication/authorization enforcement is
// deferred, but UI and server actions already route through these checks so
// wiring up real auth later means changing getCurrentAccount(), not every
// call site.

export function canManageAccounts(role: AccountRole | undefined) {
  return role === "ADMIN";
}

export function canManageSystemSettings(role: AccountRole | undefined) {
  return role === "ADMIN";
}

// Bulk Contact Import — Admin and Manager only (Travel Agents and every
// other role are excluded). Kept as its own named function (rather than
// reusing canManageAccounts/canReassignLeads, which happen to overlap
// today) so a future change to any of those concepts can't silently drag
// this one along — same reasoning canApproveExchangeOrCancellation's own
// comment gives for not reusing canReassignLeads.
export function canBulkImportContacts(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "MANAGER";
}

export function canEnterTicketingInfo(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "TICKETING_AGENT";
}

export function canChargePayments(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "TICKETING_AGENT";
}

export function canCreateQuotes(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "TRAVEL_AGENT" || role === "FLIGHT_EXPERT";
}

// Every user may manage sequences they personally created (ownership check
// happens at the call site — see src/server/actions/sequences.ts); Admin and
// Manager may additionally manage every sequence company-wide regardless of
// who created it. This function alone answers "does this role have ANY
// sequence-management capability at all" (gates page/nav visibility) —
// per-sequence ownership is enforced separately.
export function canManageSequences(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "TRAVEL_AGENT" || role === "MANAGER";
}

// Admin/Manager may manage every sequence company-wide, not just their own.
export function canManageAllSequences(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "MANAGER";
}

// Reassigning a Contact/Lead away from its current owner (not the same as
// claiming a currently-unassigned lead, which any active account may still
// do) — deliberately restricted to the roles positioned to make that call.
export function canReassignLeads(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "MANAGER";
}

// Item 12 — once a Lead reaches BOOKED (via the completed charged-quote/
// ticketing workflow), only Admin/Manager may manually change it away from
// that status. Kept as its own named function (rather than reusing
// canApproveExchangeOrCancellation, which happens to share the same role
// set today) so a future change to either concept can't silently drag the
// other along — same reasoning that function's own comment gives for not
// reusing canReassignLeads. Deliberately narrower than a blanket "who can
// change lead status" gate: every OTHER status transition remains open to
// whichever role already has ownership/visibility of the lead, unchanged.
export function canChangeBookedLeadStatus(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "MANAGER";
}

// Approving/rejecting an Exchange or Cancellation request against a
// charged quote — a financially/operationally significant decision, so
// restricted to the same Admin/Manager ceiling as other oversight actions.
// Kept as its own named function (rather than reusing canReassignLeads,
// which happens to share the same role set today) so a future change to
// either concept can't silently drag the other along with it.
export function canApproveExchangeOrCancellation(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "MANAGER";
}

// Deletion — a distinct, narrower ceiling than everyday edit access.
// Admin: contacts, leads, quotes, and bookings. Manager: contacts and leads
// only — never quotes or bookings, which carry payment/ticketing history a
// Manager isn't authorized to destroy. Every other role: none of the four.
// The database's own FK cascade (Contact -> Lead -> Quote -> Booking, see
// prisma/schema.prisma's onDelete: Cascade chain) is what actually removes
// dependent records when a parent is deleted — these functions are the
// authorization gate in front of that, not a re-implementation of it.
export function canDeleteContact(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "MANAGER";
}

export function canDeleteLead(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "MANAGER";
}

export function canDeleteQuote(role: AccountRole | undefined) {
  return role === "ADMIN";
}

export function canDeleteBooking(role: AccountRole | undefined) {
  return role === "ADMIN";
}

// Row-level visibility: does this role see every Contact/Lead/Quote/Booking
// org-wide, or only records it owns? ADMIN and MANAGER get full visibility
// as the obvious oversight roles. TICKETING_AGENT is included deliberately,
// not an oversight — ticketing/payment is a shared cross-agent back-office
// queue today (the Bookings list/detail and charge-payment flow already
// apply zero per-agent filtering), so scoping it to "my own leads" would
// break an existing, working cross-agent workflow rather than add security.
// TRAVEL_AGENT and FLIGHT_EXPERT (grouped with TRAVEL_AGENT in
// canCreateQuotes — both are customer-facing agent roles that build their
// own quotes for their own leads) are restricted to their own records.
export function canViewAllRecords(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "MANAGER" || role === "TICKETING_AGENT";
}

// Quotes/Bookings-specific variant of the above: everything canViewAllRecords
// grants, PLUS Flight Expert — who needs company-wide visibility into every
// quote and booking to do flight-ticketing work, without also gaining
// canViewAllRecords's company-wide Contacts/Leads visibility (Flight Expert
// is barred from those pages entirely at the page level — see
// BACK_OFFICE_ONLY_ROLES below). Kept as a separate function rather than
// widening canViewAllRecords itself, so the two resource groups can never
// silently drift back together.
export function canViewAllQuotesAndBookings(role: AccountRole | undefined) {
  return canViewAllRecords(role) || role === "FLIGHT_EXPERT";
}

// Page/route-level visibility — distinct from canViewAllRecords (which
// controls ROW scope within a page a role can already reach). These gate
// whether the role can reach the page AT ALL. Enforced in three places for
// each: sidebar.tsx (hides the nav link), proxy.ts (redirects direct/typed
// navigation to a blocked route), and the page component itself (notFound()
// as defense-in-depth against a direct fetch/inline navigation that
// bypasses proxy.ts). TICKETING_AGENT and FLIGHT_EXPERT are back-office
// roles with no lead-generation or sales-pipeline responsibility — they
// must never see leads, be assigned leads, or receive lead-related
// notifications (see lead-queue.ts and reference-data.ts's
// listLeadEligibleAgents). TRAVEL_AGENT never handles ticketing/payment
// confirmation, so Bookings (the ticketing/payment workflow surface) is
// hidden for that role specifically.
const BACK_OFFICE_ONLY_ROLES: AccountRole[] = ["TICKETING_AGENT", "FLIGHT_EXPERT"];

// Marketing Agent is its own, even-more-restricted case: sidebar access
// limited to Subscriptions + Accounts only — no CRM sales-pipeline surface
// at all (dashboard/contacts/leads/sequences/tasks/bookings), unlike
// TICKETING_AGENT/FLIGHT_EXPERT which retain Quotes/Bookings.
function isMarketingOnly(role: AccountRole | undefined) {
  return role === "MARKETING_AGENT";
}

export function canViewDashboard(role: AccountRole | undefined) {
  return !!role && !BACK_OFFICE_ONLY_ROLES.includes(role) && !isMarketingOnly(role);
}

export function canViewContacts(role: AccountRole | undefined) {
  return !!role && !BACK_OFFICE_ONLY_ROLES.includes(role) && !isMarketingOnly(role);
}

export function canViewLeads(role: AccountRole | undefined) {
  return !!role && !BACK_OFFICE_ONLY_ROLES.includes(role) && !isMarketingOnly(role);
}

export function canViewSequencesPage(role: AccountRole | undefined) {
  return !!role && !BACK_OFFICE_ONLY_ROLES.includes(role) && !isMarketingOnly(role);
}

export function canViewTasks(role: AccountRole | undefined) {
  return !!role && !BACK_OFFICE_ONLY_ROLES.includes(role) && !isMarketingOnly(role);
}

export function canViewBookings(role: AccountRole | undefined) {
  return !!role && role !== "TRAVEL_AGENT" && !isMarketingOnly(role);
}

// Quotes list/detail/builder pages — every role except Marketing Agent
// (whose sidebar entry, sidebar.tsx, already excludes the Quotes link on
// this exact condition). Row-level scoping (quoteVisibilityWhere) already
// makes a Marketing Agent's Quotes list come back empty since they can
// never own a lead/contact/quote, so this was never a data leak — but the
// route itself was reachable by direct URL with no guard at all, unlike
// every other role-scoped page in this app (each of which is enforced at
// sidebar + proxy.ts + page level). Added here so /quotes gets the same
// three-layer defense-in-depth as Commissions/Salesboard/Bookings/etc.
export function canViewQuotesPage(role: AccountRole | undefined) {
  return !!role && !isMarketingOnly(role);
}

// Part 9 — admin-only public-website inquiry inbox.
export function canViewGetInTouch(role: AccountRole | undefined) {
  return role === "ADMIN";
}

// Part 10/11 — Admin and Marketing Agent both see Subscriptions (the one
// CRM surface Marketing Agent is allowed at all, alongside Accounts).
export function canViewSubscriptions(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "MARKETING_AGENT";
}

// Part 14 — Commissions: Admin/Manager see everyone's, Travel Agent sees
// their own (enforced at the query layer, not here — this only gates
// whether the page/nav link is reachable at all).
export function canViewCommissions(role: AccountRole | undefined) {
  return role === "ADMIN" || role === "MANAGER" || role === "TRAVEL_AGENT";
}

// Item 5 (launch-readiness pass) — Salesboard is now open to every
// authenticated role, not just the sales-visibility roles Commissions uses.
// Deliberately its own check (not reusing canViewCommissions, even though
// they used to share the same role set) so a future change to either
// concept can't silently drag the other along — same reasoning
// canApproveExchangeOrCancellation's own comment gives for not reusing
// canReassignLeads. Row-level scope is still company-only (getSalesboard
// already filters by companyId) and commission %/tip % are still never
// queried/exposed here (see salesboard.ts's own comment) — opening page
// access does not widen what data the page itself shows.
export function canViewSalesboard(role: AccountRole | undefined) {
  return !!role;
}

/** Where to send a role after a blocked-route redirect, or after actions
 * like the /users self-redirect that assume /dashboard is reachable — that
 * assumption breaks for TICKETING_AGENT/FLIGHT_EXPERT, who keep Quotes and
 * Bookings but not Dashboard, and for MARKETING_AGENT, who has neither. */
export function defaultRouteForRole(role: AccountRole | undefined): string {
  if (isMarketingOnly(role)) return "/subscriptions";
  if (role && BACK_OFFICE_ONLY_ROLES.includes(role)) return "/quotes";
  return "/dashboard";
}

export const ROLE_LABELS: Record<AccountRole, string> = {
  ADMIN: "Admin",
  TRAVEL_AGENT: "Travel Agent",
  TICKETING_AGENT: "Ticketing Agent",
  FLIGHT_EXPERT: "Flight Expert",
  MANAGER: "Manager",
  MARKETING_AGENT: "Marketing Agent",
};

// ─────────────────────────────────────────────────────────────────────────
// Payment permissions — default-deny, explicit, per-account grants on top
// of (never instead of) a role ceiling. Role membership alone is NEVER
// sufficient for a payment-sensitive action: an ADMIN with an empty
// paymentPermissions array can do none of these, and no role outside the
// stated ceiling can ever be granted one no matter what's in the array.
// ─────────────────────────────────────────────────────────────────────────

export const PAYMENT_PERMISSIONS = [
  "payments.view",
  "payments.collect",
  "payments.reveal",
  "payments.manage",
  "payments.charge",
  // Additive, backward-compatible aliases: grant either payments.reveal or
  // payments.manual_supplier_payment for the same reveal-for-manual-entry
  // capability, and either payments.charge or payments.confirm_manual_payment
  // for the same manual-confirmation capability. Existing "payments.reveal"/
  // "payments.charge" grants keep working unchanged — these are additional
  // vocabulary, not a rename.
  "payments.manual_supplier_payment",
  "payments.confirm_manual_payment",
] as const;

export type PaymentPermission = (typeof PAYMENT_PERMISSIONS)[number];

export function isPaymentPermission(value: string): value is PaymentPermission {
  return (PAYMENT_PERMISSIONS as readonly string[]).includes(value);
}

export const PAYMENT_PERMISSION_LABELS: Record<PaymentPermission, string> = {
  "payments.view": "View masked payment info",
  "payments.collect": "Collect card details",
  "payments.reveal": "Reveal full card number",
  "payments.manage": "Manage payment permissions",
  "payments.charge": "Record manual payment confirmation",
  "payments.manual_supplier_payment": "Start Supplier Payment (CVV authorization)",
  "payments.confirm_manual_payment": "Confirm manual supplier payment",
};

type PaymentAccount = { role: AccountRole; paymentPermissions: string[] } | null | undefined;

export function hasPaymentPermission(account: PaymentAccount, permission: PaymentPermission): boolean {
  return !!account?.paymentPermissions?.includes(permission);
}

// Only these three roles may ever hold payments.reveal, regardless of what
// gets granted — matches the spec's explicit ceiling.
export const REVEAL_ELIGIBLE_ROLES: AccountRole[] = ["ADMIN", "MANAGER", "TICKETING_AGENT"];

/** Full-PAN reveal requires BOTH an eligible role AND the explicit
 * payments.reveal (or payments.manual_supplier_payment) grant — neither a
 * role alone nor a permission on an ineligible role is ever sufficient. */
export function canRevealPaymentMethod(account: PaymentAccount): boolean {
  if (!account) return false;
  // Every Admin has identical effective permissions — role alone is
  // sufficient, never gated by that specific account's grant array. See
  // the same bypass on canConfirmPayment/canAuthorizeSupplierPayment/
  // canManageContactPaymentMethods/canRevealBookingIp below.
  if (account.role === "ADMIN") return true;
  if (!REVEAL_ELIGIBLE_ROLES.includes(account.role)) return false;
  return hasPaymentPermission(account, "payments.reveal") || hasPaymentPermission(account, "payments.manual_supplier_payment");
}

/** Manually confirming a payment was processed (replaces the old
 * Stripe-driven automatic charge-success signal) — same role ceiling as
 * the pre-existing canChargePayments, plus the explicit grant. */
export function canConfirmPayment(account: PaymentAccount): boolean {
  if (!account) return false;
  if (account.role === "ADMIN") return true;
  if (!canChargePayments(account.role)) return false;
  return hasPaymentPermission(account, "payments.charge") || hasPaymentPermission(account, "payments.confirm_manual_payment");
}

/**
 * Gates the "Start Supplier Payment" short-lived authorization workflow (see
 * server/security/cvv-authorization.ts) — a deliberately narrower check than
 * canRevealPaymentMethod. That workflow surfaces more sensitive, transient
 * verification data during an active authorization, so it requires the
 * specific payments.manual_supplier_payment grant; holding only
 * payments.reveal (view/reveal card number, nothing transient involved) is
 * NOT sufficient here, even though the reverse is true for
 * canRevealPaymentMethod. Same three-role ceiling as every other
 * payment-reveal-adjacent action.
 */
export function canAuthorizeSupplierPayment(account: PaymentAccount): boolean {
  if (!account) return false;
  if (account.role === "ADMIN") return true;
  if (!REVEAL_ELIGIBLE_ROLES.includes(account.role)) return false;
  return hasPaymentPermission(account, "payments.manual_supplier_payment");
}

/** Add/Edit/Remove a Contact's stored payment methods (independent of any
 * specific booking) — same three-role ceiling as every other privileged
 * payment action, gated on the existing payments.collect grant (already
 * used for the booking-form card-collection concept; reused here rather
 * than inventing a parallel permission string for the same underlying
 * capability). */
export function canManageContactPaymentMethods(account: PaymentAccount): boolean {
  if (!account) return false;
  if (account.role === "ADMIN") return true;
  if (!REVEAL_ELIGIBLE_ROLES.includes(account.role)) return false;
  return hasPaymentPermission(account, "payments.collect");
}

/** Card vault feature-request follow-up — deleting a stored card is now a
 * strictly Admin-only action, deliberately narrower than
 * canManageContactPaymentMethods (add/edit) above, which any
 * payments.collect-granted eligible role can still do. A user's explicit
 * request specified deletion as admin-only; every other payment-method
 * permission in this file already used the "ADMIN always; else role
 * ceiling + explicit grant" shape, so a real per-role delete grant was
 * deliberately NOT added here — the request was for a single fixed rule,
 * not a new configurable permission, and adding one nobody asked for
 * would only be speculative complexity. */
export function canDeletePaymentMethod(account: { role: AccountRole } | null | undefined): boolean {
  return account?.role === "ADMIN";
}

/** Whether a given role is even eligible to hold a given payment permission
 * — used when an Admin grants permissions, so the grant UI can't produce a
 * combination (e.g. payments.reveal on a Travel Agent) that canRevealPaymentMethod/
 * canConfirmPayment would silently ignore anyway. */
export function isPaymentPermissionGrantableForRole(permission: PaymentPermission, role: AccountRole): boolean {
  if (permission === "payments.reveal" || permission === "payments.manual_supplier_payment") return REVEAL_ELIGIBLE_ROLES.includes(role);
  if (permission === "payments.charge" || permission === "payments.confirm_manual_payment") return canChargePayments(role);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Booking security permissions — same default-deny, explicit-grant,
// role-ceiling pattern as payment permissions, kept in a separate
// Account.bookingPermissions array so granting IP-reveal access is an
// independent decision from granting payment-reveal access.
// ─────────────────────────────────────────────────────────────────────────

export const BOOKING_PERMISSIONS = ["bookings.reveal_ip"] as const;

export type BookingPermission = (typeof BOOKING_PERMISSIONS)[number];

export function isBookingPermission(value: string): value is BookingPermission {
  return (BOOKING_PERMISSIONS as readonly string[]).includes(value);
}

export const BOOKING_PERMISSION_LABELS: Record<BookingPermission, string> = {
  "bookings.reveal_ip": "Reveal booking submission IP address",
};

type BookingSecurityAccount = { role: AccountRole; bookingPermissions: string[] } | null | undefined;

export function hasBookingPermission(account: BookingSecurityAccount, permission: BookingPermission): boolean {
  return !!account?.bookingPermissions?.includes(permission);
}

// Same three back-office roles eligible for payments.reveal — the booking
// submission IP is exactly the kind of security metadata those roles are
// already positioned to investigate (fraud/chargeback review, supplier
// disputes), while customer-facing agent roles have no need for it.
const REVEAL_IP_ELIGIBLE_ROLES: AccountRole[] = ["ADMIN", "MANAGER", "TICKETING_AGENT"];

export function canRevealBookingIp(account: BookingSecurityAccount): boolean {
  if (!account) return false;
  if (account.role === "ADMIN") return true;
  if (!REVEAL_IP_ELIGIBLE_ROLES.includes(account.role)) return false;
  return hasBookingPermission(account, "bookings.reveal_ip");
}

export function isBookingPermissionGrantableForRole(permission: BookingPermission, role: AccountRole): boolean {
  if (permission === "bookings.reveal_ip") return REVEAL_IP_ELIGIBLE_ROLES.includes(role);
  return true;
}
