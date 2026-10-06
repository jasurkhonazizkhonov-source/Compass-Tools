// Private route prefixes for robots.txt. Every top-level directory under src/app/(crm) must appear here (a test enforces it) so a new
// CRM section can't be forgotten. robots.txt is a courtesy to well-behaved crawlers, NOT an access control: these routes are protected
// by the session gate (proxy.ts) and per-action authorization, and a disallowed URL can still be requested by anyone.
//
// `/login` is deliberately NOT listed: it carries `noindex`, and a crawler can only honour that directive if it may fetch the page.
export const PRIVATE_DISALLOW = [
  "/api/",
  "/access-denied",
  "/dashboard",
  "/accounts",
  "/bookings",
  "/commissions",
  "/company",
  "/contacts",
  "/leads",
  "/quotes",
  "/salesboard",
  "/sequences",
  "/subscriptions",
  "/tasks",
  "/users",
  "/get-in-touch",
  "/crm-inquiries",
  "/system-health",
  // Customer-facing but token-gated (a unique, unguessable link per quote/booking) — never something a crawler should index either.
  "/quote/",
];
