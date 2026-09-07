"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Switch } from "@/components/ui/switch";
import { toggleSequenceActive } from "@/server/actions/sequences";

export function SequenceActiveToggle({ sequenceId, isActive }: { sequenceId: string; isActive: boolean }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">{isActive ? "Active" : "Inactive"}</span>
      <Switch
        checked={isActive}
        disabled={isPending}
        onCheckedChange={() => startTransition(async () => {
          await toggleSequenceActive(sequenceId);
          router.refresh();
        })}
      />
    </div>
  );
}
