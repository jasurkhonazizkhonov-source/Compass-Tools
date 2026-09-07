import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { DEV_ACCOUNT_COOKIE, isSessionExpired } from "@/lib/dev-session";
import {
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
  defaultRouteForRole,
} from "@/lib/permissions";
import type { AccountRole } from "@/generated/prisma/client";

// Route-prefix -> role-visibility predicate, checked in matcher order below.
// Kept data-driven so proxy.ts and sidebar.tsx stay easy to keep in sync —
// both ultimately defer to the same permissions.ts predicates.
const ROUTE_GUARDS: Array<{ prefix: string; allowed: (role: AccountRole | undefined) => boolean }> = [
  { prefix: "/dashboard", allowed: canViewDashboard },
  { prefix: "/contacts", allowed: canViewContacts },
  { prefix: "/leads", allowed: canViewLeads },
  { prefix: "/quotes", allowed: canViewQuotesPage },
  { prefix: "/sequences", allowed: canViewSequencesPage },
  { prefix: "/tasks", allowed: canViewTasks },
  { prefix: "/bookings", allowed: canViewBookings },
  { prefix: "/get-in-touch", allowed: canViewGetInTouch },
  { prefix: "/subscriptions", allowed: canViewSubscriptions },
  { prefix: "/commissions", allowed: canViewCommissions },
  { prefix: "/salesboard", allowed: canViewSalesboard },
];

// Gates every internal CRM route behind a real, server-verified session:
// the cookie must hold a token that still matches the account's CURRENT
// activeSessionId (single-active-device — a superseded token from an older
// login on a different device fails this lookup) and the session must be
// within its 24h absolute lifetime (isSessionExpired), in addition to the
// account being ACTIVE. This proxy runs before any CRM page/Server
// Component renders, so it's enforced at the routing level rather than
// relying on a hidden UI element.
//
// Real credential verification happens at login (Google Identity Services'
// ID token verified server-side in src/server/auth/verify-google-token.ts,
// then CRM authorization checked in src/server/auth/
// google-authorization.ts) — this proxy only enforces that whatever
// session cookie a request carries still matches the account's CURRENT,
// unexpired session, established after both of those checks passed. A
// visitor who somehow obtained another employee's current, unexpired
// session token would still get through this layer alone — session-token
// theft is a separate threat model from login credential verification.
//
// Next.js 16 renamed middleware.ts -> proxy.ts (export `proxy`, not
// `middleware`) — this file must keep that exact name/export.
export async function proxy(request: NextRequest) {
  const token = request.cookies.get(DEV_ACCOUNT_COOKIE)?.value;

  if (token) {
    const account = await prisma.account.findUnique({
      where: { activeSessionId: token },
      select: { status: true, role: true, sessionCreatedAt: true },
    });
    // A session that matched a real account but has passed its 24h absolute
    // lifetime gets its own redirect reason (?reason=expired) so /login can
    // show "your session has expired" instead of a bare sign-in page — see
    // src/app/login/page.tsx. Every other denial path (no cookie at all,
    // status no longer ACTIVE, no matching account) falls through to the
    // plain /login redirect below, unchanged from before.
    if (account && account.status === "ACTIVE" && isSessionExpired(account.sessionCreatedAt)) {
      const response = NextResponse.redirect(new URL("/login?reason=expired", request.url));
      response.cookies.delete(DEV_ACCOUNT_COOKIE);
      return response;
    }
    if (account?.status === "ACTIVE" && !isSessionExpired(account.sessionCreatedAt)) {
      // /users is admin-only user management, distinct from the general
      // /accounts directory every active account can see — everything
      // else matched below only requires a valid active account. A
      // signed-in-but-non-admin request is redirected to /dashboard
      // (they DO have real CRM access, just not to this page) rather than
      // /access-denied (reserved for "not signed in at all"), so the
      // messaging stays accurate for each case. The /users page itself
      // repeats this exact check server-side (returns 404 for a non-admin)
      // as defense-in-depth, and every account-mutating server action
      // asserts admin independently again — this proxy check alone is not
      // the only enforcement layer.
      if (request.nextUrl.pathname.startsWith("/users") && account.role !== "ADMIN") {
        return NextResponse.redirect(new URL(defaultRouteForRole(account.role), request.url));
      }
      // Admin-only Company settings (branding, logo, email signature) — same
      // pattern as /users above.
      if (request.nextUrl.pathname.startsWith("/company") && account.role !== "ADMIN") {
        return NextResponse.redirect(new URL(defaultRouteForRole(account.role), request.url));
      }
      // Admin/Manager-only Bulk Contacts import — same pattern as /users
      // above, but deferring to canBulkImportContacts (rather than a
      // hardcoded role check) so this can never drift from the same rule
      // the page and every bulk-contacts server action enforce. A static
      // sibling of the dynamic /contacts/[id] route (matched first by
      // Next's own routing since it's a literal segment), same convention
      // as /subscriptions/campaigns/new alongside
      // /subscriptions/campaigns/[id].
      if (request.nextUrl.pathname.startsWith("/contacts/bulk-import") && !canBulkImportContacts(account.role)) {
        return NextResponse.redirect(new URL(defaultRouteForRole(account.role), request.url));
      }
      // Role-scoped pages (Ticketing Agent/Flight Expert lose Dashboard,
      // Contacts, Leads, Sequences, Tasks; Travel Agent loses Bookings) —
      // repeated at the page level (notFound()) as defense-in-depth against
      // any request that reaches the page component without going through
      // this proxy.
      for (const guard of ROUTE_GUARDS) {
        if (request.nextUrl.pathname.startsWith(guard.prefix) && !guard.allowed(account.role)) {
          return NextResponse.redirect(new URL(defaultRouteForRole(account.role), request.url));
        }
      }
      return NextResponse.next();
    }
  }

  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: [
    "/",
    "/dashboard",
    "/dashboard/:path*",
    "/leads/:path*",
    "/contacts/:path*",
    "/quotes/:path*",
    "/bookings/:path*",
    "/accounts/:path*",
    "/sequences/:path*",
    "/tasks/:path*",
    "/users/:path*",
    "/company/:path*",
    "/get-in-touch/:path*",
    "/subscriptions/:path*",
    "/commissions/:path*",
    "/salesboard/:path*",
  ],
};
