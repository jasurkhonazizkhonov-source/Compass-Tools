"use client";

import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Compact icon-only reassign trigger — visually matches CallButton (same
 * size, `variant="outline"`, Tooltip on hover) so the two sit naturally
 * side by side in a table row's action column. Purely presentational: the
 * actual click-to-open behavior is attached by whichever dialog wraps this
 * (ReassignContactDialog / ReassignLeadDialog both accept it as a custom
 * `trigger`), so this component has no onClick of its own. */
export function ReassignIconTrigger({ label, size = "icon-sm" }: { label: string; size?: "icon-sm" | "icon" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size={size} aria-label={label} type="button">
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
