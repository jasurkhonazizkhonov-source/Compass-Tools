"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { processDueSequenceSteps } from "@/server/actions/sequences";

export function ProcessDueButton() {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function run() {
    startTransition(async () => {
      const result = await processDueSequenceSteps();
      if (result.processed === 0) {
        toast.info("No enrollments are due right now");
      } else {
        toast.success(`Processed ${result.processed} · Sent ${result.sent} · Failed ${result.failed}`);
      }
      router.refresh();
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={run} disabled={isPending} className="gap-1.5">
      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
      Process Due Steps
    </Button>
  );
}
