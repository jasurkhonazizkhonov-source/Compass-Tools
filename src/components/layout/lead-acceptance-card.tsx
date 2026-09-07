"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Play, Pause, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { joinLeadQueue, leaveLeadQueue } from "@/server/actions/lead-queue";

export function LeadAcceptanceCard({
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
      const result = isActive ? await leaveLeadQueue() : await joinLeadQueue();
      if (result.ok) {
        setIsActive(!isActive);
        setPosition(result.position);
        toast.success(isActive ? "Paused — your queue position is preserved" : "You're now accepting new leads");
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Lead Acceptance</CardTitle>
        <Users className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Your Queue Position</span>
          <span className="font-semibold tabular-nums">{position ? `#${position}` : "—"}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Status</span>
          <span className={cn("inline-flex items-center gap-1.5 font-medium", isActive ? "text-success" : "text-muted-foreground")}>
            <span className={cn("h-2 w-2 rounded-full", isActive ? "bg-success" : "bg-muted-foreground")} />
            {isActive ? "Accepting Leads" : "Paused"}
          </span>
        </div>
        <Button
          onClick={handleClick}
          disabled={isPending}
          variant={isActive ? "outline" : "default"}
          className="w-full gap-1.5"
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isActive ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {isActive ? "Stop Accepting Leads" : "Accept Leads"}
        </Button>
      </CardContent>
    </Card>
  );
}
