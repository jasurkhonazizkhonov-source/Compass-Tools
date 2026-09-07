"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Play, Pause, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { joinLeadQueue, leaveLeadQueue } from "@/server/actions/lead-queue";

export function LeadQueueToggle({
  initialIsActive,
  initialPosition,
}: {
  initialIsActive: boolean;
  initialPosition: number | null;
}) {
  const [isActive, setIsActive] = useState(initialIsActive);
  const [position, setPosition] = useState(initialPosition);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      if (isActive) {
        const result = await leaveLeadQueue();
        if (result.ok) {
          setIsActive(false);
          setPosition(result.position);
          toast.success("Paused — your queue position is preserved");
        } else {
          toast.error(result.error);
        }
      } else {
        const result = await joinLeadQueue();
        if (result.ok) {
          setIsActive(true);
          setPosition(result.position);
          toast.success("You're now accepting new leads");
        } else {
          toast.error(result.error);
        }
      }
    });
  }

  return (
    <Button
      variant={isActive ? "default" : "outline"}
      size="sm"
      onClick={handleClick}
      disabled={isPending}
      className={cn("gap-1.5", isActive && "bg-success text-success-foreground hover:bg-success/90")}
      title={
        isActive
          ? "You're accepting leads — click to pause (your queue position is kept)"
          : "Accept leads — click to resume, you'll keep your queue position"
      }
      // Explicit and breakpoint-independent, matching account-menu.tsx's
      // identical treatment: below `lg` the descriptive text span is
      // visually hidden (display:none, dropped from the accessibility
      // tree too), and when `position` is also null the icon-only button
      // would otherwise have no text content at all to derive a name from.
      aria-label={position ? `Lead queue: #${position}, ${isActive ? "accepting" : "paused"}` : isActive ? "Accepting leads" : "Accept leads"}
    >
      {isPending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
      ) : isActive ? (
        <Pause className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Play className="h-3.5 w-3.5 shrink-0" />
      )}
      {/* `lg`, not `sm` — see pacific-clock.tsx's comment on the 768px
          topbar overflow this fixes. Purely a visual breakpoint change —
          the button's accessible name now always comes from the explicit
          aria-label above, independent of which span is visible. */}
      <span className="hidden lg:inline">
        {position ? `#${position} · ${isActive ? "Accepting" : "Paused"}` : isActive ? "Accepting Leads" : "Accept Leads"}
      </span>
      {position != null && <span className="lg:hidden">#{position}</span>}
    </Button>
  );
}
