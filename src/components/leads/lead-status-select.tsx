"use client";

import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, Loader2, Lock } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/crm/status-badge";
import { LEAD_STATUS_META, LEAD_STATUS_ORDER, toneClass } from "@/lib/status-meta";
import { updateLeadStatus } from "@/server/actions/leads";
import { canChangeBookedLeadStatus } from "@/lib/permissions";
import type { AccountRole, LeadStatus } from "@/generated/prisma/client";
import { cn } from "@/lib/utils";

export function LeadStatusSelect({
  leadId,
  status,
  badgeClassName,
  viewerRole,
}: {
  leadId: string;
  status: LeadStatus;
  badgeClassName?: string;
  /** Item 12 — once a lead reaches BOOKED, only Admin/Manager may change it
   * away from that status. Server-enforced regardless (updateLeadStatus
   * throws for any other role) — this prop only drives the UI-level lock,
   * matching this codebase's established "server is authoritative, UI just
   * reflects it clearly" convention (see booking-ticketing-form.tsx's own
   * canEdit-style gating). Omitting it defaults to the safe/locked
   * behavior, never the permissive one. */
  viewerRole?: AccountRole;
}) {
  const [isPending, startTransition] = useTransition();
  const [optimisticStatus, setOptimisticStatus] = useOptimistic(status);

  const locked = optimisticStatus === "BOOKED" && !canChangeBookedLeadStatus(viewerRole);

  function handleSelect(next: LeadStatus) {
    if (next === optimisticStatus) return;
    startTransition(async () => {
      setOptimisticStatus(next);
      try {
        await updateLeadStatus(leadId, next);
        toast.success(`Status updated to ${LEAD_STATUS_META[next].label}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update status");
      }
    });
  }

  const meta = LEAD_STATUS_META[optimisticStatus];

  if (locked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 cursor-not-allowed">
            <StatusBadge label={meta.label} tone={meta.tone} className={cn("opacity-90", badgeClassName)} />
            <Lock className="h-3 w-3 text-muted-foreground" />
          </span>
        </TooltipTrigger>
        <TooltipContent>Only an Admin or Manager can change a Booked lead&apos;s status</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={isPending}>
        <button className="inline-flex items-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
          {isPending ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Updating...
            </span>
          ) : (
            <StatusBadge label={meta.label} tone={meta.tone} className={cn("cursor-pointer hover:opacity-80", badgeClassName)} />
          )}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {LEAD_STATUS_ORDER.map((s) => {
          const m = LEAD_STATUS_META[s];
          return (
            <DropdownMenuItem key={s} onSelect={() => handleSelect(s)} className="gap-2">
              <span className={cn("h-2 w-2 rounded-full border", toneClass(m.tone))} />
              <span className="flex-1">{m.label}</span>
              {s === optimisticStatus && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
