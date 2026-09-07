"use client";

import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Browsers only let a script close a tab it opened itself via window.open()
 * — a tab reached by clicking a normal link (the common case here, e.g.
 * from an email) can't be force-closed, and there's no reliable way to
 * detect in advance which case this is. Rather than a "Close" button that
 * silently does nothing for most visitors (and only shows an explanation
 * after the fact, once they've already clicked something that visibly
 * failed), this is honest up front: the explanatory text is always visible,
 * and the button is labeled "Done" — a true statement regardless of
 * whether window.close() happens to succeed. window.close() is still
 * attempted on click (free when it works, harmless no-op otherwise).
 */
export function CloseBookingButton({ compact = false }: { compact?: boolean }) {
  function handleDone() {
    window.close();
  }

  return (
    <div className={compact ? "relative" : undefined}>
      <Button variant="outline" size={compact ? "sm" : "default"} onClick={handleDone} className="gap-1.5">
        <Check className="h-4 w-4" /> Done
      </Button>
      <p
        className={
          compact
            ? "absolute right-0 top-full mt-1.5 w-56 text-right text-xs text-muted-foreground"
            : "text-xs text-muted-foreground mt-2"
        }
      >
        You can safely close this tab now.
      </p>
    </div>
  );
}
