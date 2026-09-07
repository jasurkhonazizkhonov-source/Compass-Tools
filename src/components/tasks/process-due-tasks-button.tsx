"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BellRing, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { processDueTaskNotifications } from "@/server/actions/tasks";

export function ProcessDueTasksButton() {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function run() {
    startTransition(async () => {
      const result = await processDueTaskNotifications();
      if (result.scanned === 0) {
        toast.info("No tasks are due right now");
      } else {
        toast.success(`Scanned ${result.scanned} · Notified ${result.notified}`);
      }
      router.refresh();
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={run} disabled={isPending} className="gap-1.5">
      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BellRing className="h-3.5 w-3.5" />}
      Process Due Tasks
    </Button>
  );
}
