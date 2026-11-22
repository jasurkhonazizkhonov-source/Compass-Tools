"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eye, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { revealContactEmails } from "@/server/actions/customer-email";
import { REVEAL_RESET_LABEL } from "@/lib/business-time";

/**
 * The "Reveal" control and the daily-allowance indicator for a customer's email addresses. Rendered only for a viewer who is subject to masking (the server decides
 * that - an Administrator or a user with Unlimited Customer Email Access never gets this component). The button asks the SERVER to reveal; the server enforces the
 * allowance atomically and, on success, the page is re-rendered by the server with the complete addresses. Nothing here can unmask anything by itself.
 */
export function CustomerEmailReveal({
  contactId,
  leadId,
  masked,
  used,
  limit,
}: {
  contactId: string;
  leadId?: string;
  /** true -> this customer is still masked for this viewer (show Reveal). false -> already revealed today (just the indicator). */
  masked: boolean;
  used: number;
  limit: number;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // The server's count is the truth; a count returned by a reveal is shown until the server sends a different one (for example after the 13:15 Pacific reset).
  const [local, setLocal] = useState<{ forUsed: number; value: number } | null>(null);
  const counter = local && local.forUsed === used ? local.value : used;
  const [error, setError] = useState<string | null>(null);
  const exhausted = counter >= limit;

  function reveal() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await revealContactEmails(contactId, leadId);
        if (!result.ok) {
          if (result.usage) setLocal({ forUsed: used, value: result.usage.used });
          setError(result.error);
          toast.error(result.error);
          return;
        }
        setLocal({ forUsed: used, value: result.usage.used });
        router.refresh();
      } catch {
        setError("The email could not be revealed. Nothing was counted against your allowance.");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="customer-email-reveal">
      {masked && (
        <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={reveal} disabled={isPending || exhausted} aria-label="Reveal customer email">
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Eye className="h-3 w-3" aria-hidden />}
          Reveal
        </Button>
      )}
      <span className="text-muted-foreground" data-testid="customer-email-usage">
        Customer email reveals: {counter} / {limit} used this period
      </span>
      {masked && exhausted && <span className="text-muted-foreground">No reveals left. The allowance resets at {REVEAL_RESET_LABEL}.</span>}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
