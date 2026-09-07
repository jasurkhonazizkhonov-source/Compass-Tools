"use client";

import { Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function CallButton({ phone, size = "icon-sm" }: { phone: string | null | undefined; size?: "icon-sm" | "icon" }) {
  if (!phone) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size={size}
          asChild
          onClick={(e) => e.stopPropagation()}
        >
          <a href={`tel:${phone.replace(/[^+\d]/g, "")}`} aria-label={`Call ${phone}`}>
            <Phone className="h-3.5 w-3.5" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Call {phone}</TooltipContent>
    </Tooltip>
  );
}
