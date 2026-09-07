"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SidebarBrand, SidebarNav } from "@/components/layout/sidebar";
import { GlobalSearch } from "@/components/layout/global-search";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { AccountMenu } from "@/components/layout/account-menu";
import { NotificationBell } from "@/components/layout/notification-bell";
import { LeadQueueToggle } from "@/components/layout/lead-queue-toggle";
import { LeadOfferModal } from "@/components/layout/lead-offer-modal";
import { PacificClock } from "@/components/layout/pacific-clock";
import type { AccountRole } from "@/generated/prisma/client";
import type { GmailConnectionState } from "@/server/queries/gmail-connection";

type AccountOption = { id: string; fullName: string; email: string; role: AccountRole };

// Ticketing Agent and Flight Expert don't participate in lead distribution
// at all (see src/components/layout/sidebar.tsx's LEAD_WORKFLOW_ROLES) —
// showing them a queue-acceptance toggle would be misleading since backend
// enforcement (src/server/actions/lead-queue.ts) rejects them regardless.
const LEAD_QUEUE_HIDDEN_ROLES: AccountRole[] = ["TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"];

export function Topbar({
  current,
  queueStatus,
  gmailStatus,
  companyName,
}: {
  current: AccountOption | null;
  queueStatus: { isActive: boolean; position: number | null };
  gmailStatus: GmailConnectionState;
  companyName?: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b bg-background/95 backdrop-blur px-4 md:px-6">
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0 bg-sidebar text-sidebar-foreground border-sidebar-border">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex flex-col h-full">
            <SidebarBrand companyName={companyName} />
            <SidebarNav onNavigate={() => setMobileOpen(false)} role={current?.role} />
          </div>
        </SheetContent>
      </Sheet>
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </Button>

      <div className="flex-1 min-w-0 flex justify-start">
        <GlobalSearch />
      </div>

      <div className="flex items-center gap-2">
        <PacificClock />
        {!(current && LEAD_QUEUE_HIDDEN_ROLES.includes(current.role)) && (
          <LeadQueueToggle initialIsActive={queueStatus.isActive} initialPosition={queueStatus.position} />
        )}
        <NotificationBell accountId={current?.id} />
        <ThemeToggle />
        <AccountMenu current={current} gmailStatus={gmailStatus} />
      </div>

      {!(current && LEAD_QUEUE_HIDDEN_ROLES.includes(current.role)) && (
        <LeadOfferModal accountId={current?.id} />
      )}
    </header>
  );
}
