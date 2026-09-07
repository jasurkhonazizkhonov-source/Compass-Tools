"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Contact2,
  FileText,
  PlaneTakeoff,
  Mail,
  UserCog,
  ListChecks,
  ShieldCheck,
  Building2,
  Inbox,
  Send,
  DollarSign,
  Trophy,
  UploadCloud,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { CompassMark } from "@/components/brand/compass-mark";
import { cn } from "@/lib/utils";
import {
  canManageAccounts,
  canBulkImportContacts,
  canViewDashboard,
  canViewContacts,
  canViewLeads,
  canViewBookings,
  canViewTasks,
  canViewSequencesPage,
  canViewGetInTouch,
  canViewSubscriptions,
  canViewCommissions,
  canViewSalesboard,
  canViewQuotesPage,
} from "@/lib/permissions";
import { SidebarUserPanel, type SidebarAccount } from "@/components/layout/sidebar-user-panel";
import type { AccountRole } from "@/generated/prisma/client";

// Every nav item's visibility is a single predicate over the viewer's role,
// backed by the same permission functions (src/lib/permissions.ts) that
// gate the actual page/route server-side (proxy.ts + each page's own
// notFound() check + every relevant server action) — hiding the link here
// is a UX nicety on top of that real enforcement, never a substitute for
// it. Using one shared function per item (rather than the old ad-hoc
// adminOnly/hiddenFor combination) is what lets a new, more-restrictive
// role like Marketing Agent be excluded from every CRM sales-pipeline item
// automatically (canViewDashboard/canViewContacts/etc. already say no for
// that role) without having to remember to add it to every item's deny list.
const NAV_ITEMS: Array<{
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  visible: (role: AccountRole | undefined) => boolean;
}> = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, visible: canViewDashboard },
  { href: "/contacts", label: "Contacts", icon: Contact2, visible: canViewContacts },
  // Admin/Manager-only bulk contact import — same triple-layer enforcement
  // pattern as /users/company below (proxy.ts + page-level check + the
  // bulk-create server action independently asserting the same rule).
  { href: "/contacts/bulk-import", label: "Bulk Contacts", icon: UploadCloud, visible: (role) => canBulkImportContacts(role) },
  { href: "/leads", label: "Leads", icon: Users, visible: canViewLeads },
  { href: "/quotes", label: "Quotes", icon: FileText, visible: canViewQuotesPage },
  { href: "/bookings", label: "Bookings", icon: PlaneTakeoff, visible: canViewBookings },
  { href: "/tasks", label: "Tasks", icon: ListChecks, visible: canViewTasks },
  { href: "/sequences", label: "Sequences", icon: Mail, visible: canViewSequencesPage },
  { href: "/commissions", label: "Commissions", icon: DollarSign, visible: canViewCommissions },
  { href: "/salesboard", label: "Salesboard", icon: Trophy, visible: canViewSalesboard },
  { href: "/accounts", label: "Accounts", icon: UserCog, visible: (role) => !!role },
  { href: "/get-in-touch", label: "Get in Touch", icon: Inbox, visible: canViewGetInTouch },
  { href: "/subscriptions", label: "Subscriptions", icon: Send, visible: canViewSubscriptions },
  // Admin-only user management — distinct from the general Accounts
  // directory above. Hiding this nav item is a UX nicety only; the actual
  // enforcement is server-side in proxy.ts (route-level) and the /users
  // page itself (page-level), plus every account-mutating server action
  // independently asserting admin — a non-admin editing this array locally
  // or guessing the URL still cannot reach it.
  { href: "/users", label: "Users", icon: ShieldCheck, visible: (role) => canManageAccounts(role) },
  // Admin-only company branding/settings — same triple-layer enforcement
  // pattern as /users (proxy.ts + page-level check + every action
  // re-asserting admin).
  { href: "/company", label: "Company", icon: Building2, visible: (role) => canManageAccounts(role) },
];

export function SidebarBrand({ companyName, collapsed = false }: { companyName?: string; collapsed?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 h-16 shrink-0", collapsed ? "justify-center px-2" : "px-5")}>
      {/* Pass 13 §2 — a real, verifiable size increase (32px badge/24px
          mark -> 40px badge/30px mark), not just a claim: still comfortably
          within the row's existing h-16 (64px) height and the collapsed
          rail's own width, so this cannot overflow the nav or force mobile
          layout changes. */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/95 shadow-sm">
        <CompassMark className="h-[30px] w-[30px]" />
      </div>
      {!collapsed && (
        <div className="leading-tight overflow-hidden">
          <p className="text-sm font-semibold tracking-tight truncate">Compass Tools</p>
          {companyName && <p className="text-[11px] text-sidebar-foreground/60 truncate">{companyName}</p>}
        </div>
      )}
    </div>
  );
}

export function SidebarNav({ onNavigate, role, collapsed = false }: { onNavigate?: () => void; role?: AccountRole; collapsed?: boolean }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((item) => item.visible(role));

  return (
    <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 space-y-0.5">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              collapsed && "justify-center px-2",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

const SIDEBAR_COLLAPSED_KEY = "compass-tools:sidebar-collapsed";
const EXPANDED_WIDTH = "md:w-60";
const COLLAPSED_WIDTH = "md:w-16";
const EXPANDED_PADDING = "md:pl-60";
const COLLAPSED_PADDING = "md:pl-16";

/**
 * Collapsible desktop sidebar (Part 8) — wraps the `<aside>` AND the main
 * content area's left padding together in one client component, since the
 * two must always agree on which width is currently in effect (a plain
 * server-rendered `md:pl-60` on the content wrapper, with only the aside
 * collapsing, would leave a gap or an overlap). Reads the saved preference
 * via a lazy useState initializer (same pattern as CustomerThemeProvider) —
 * `typeof window === "undefined"` guards the server-render pass (always
 * expanded there, no localStorage to read), while the client's very first
 * render already reflects the saved choice, no post-mount flash back to a
 * default. `suppressHydrationWarning` covers the resulting server/client
 * markup mismatch on returning visitors, the same accepted tradeoff
 * CustomerThemeProvider documents for its own dark-mode preference. Mobile
 * is unaffected: it already uses a separate Sheet-based drawer (see
 * Topbar), not this desktop-only `<aside>`.
 */
export function SidebarShell({
  current,
  companyName,
  children,
}: {
  current?: SidebarAccount | null;
  companyName?: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => typeof window !== "undefined" && localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }

  return (
    <>
      <aside
        suppressHydrationWarning
        className={cn(
          "hidden md:flex md:flex-col md:fixed md:inset-y-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-[width] duration-200",
          collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH
        )}
      >
        <SidebarBrand companyName={companyName} collapsed={collapsed} />
        <SidebarNav role={current?.role} collapsed={collapsed} />
        <SidebarUserPanel current={current ?? null} collapsed={collapsed} />
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex items-center gap-2 border-t border-sidebar-border py-2.5 text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground transition-colors",
            collapsed ? "justify-center px-2" : "justify-start px-4"
          )}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4 shrink-0" /> : <PanelLeftClose className="h-4 w-4 shrink-0" />}
          {!collapsed && <span className="text-xs font-medium">Collapse</span>}
        </button>
      </aside>
      <div suppressHydrationWarning className={cn("transition-[padding] duration-200", collapsed ? COLLAPSED_PADDING : EXPANDED_PADDING)}>
        {children}
      </div>
    </>
  );
}
