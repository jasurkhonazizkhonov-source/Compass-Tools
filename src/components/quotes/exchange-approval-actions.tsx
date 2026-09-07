"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { approveExchange, disapproveExchange } from "@/server/actions/exchange";

/** Admin/Manager-only Approve/Disapprove for a PENDING_EXCHANGE_APPROVAL
 * exchange quote — visibility here is a UX nicety; both server actions
 * independently re-check canApproveExchangeOrCancellation before doing
 * anything. */
export function ExchangeApprovalActions({ exchangeQuoteId }: { exchangeQuoteId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleApprove() {
    startTransition(async () => {
      try {
        await approveExchange(exchangeQuoteId);
        toast.success("Exchange approved");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not approve the exchange");
      }
    });
  }

  function handleDisapprove() {
    startTransition(async () => {
      try {
        await disapproveExchange(exchangeQuoteId);
        toast.success("Exchange disapproved — original quote returned to Charged");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not disapprove the exchange");
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={handleApprove} disabled={isPending} className="gap-1.5">
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        Approve Exchange
      </Button>
      <Button variant="destructive" size="sm" onClick={handleDisapprove} disabled={isPending} className="gap-1.5">
        <X className="h-3.5 w-3.5" /> Disapprove Exchange
      </Button>
    </div>
  );
}
