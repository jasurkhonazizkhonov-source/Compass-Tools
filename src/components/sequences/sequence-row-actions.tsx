"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { deleteSequence } from "@/server/actions/sequences";

export function SequenceDeleteButton({ sequenceId, name, redirectTo }: { sequenceId: string; name: string; redirectTo?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Delete sequence"
        aria-label="Delete sequence"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this sequence?"
        description={`"${name}" and its steps will be permanently deleted. Active enrollments will stop. This can't be undone.`}
        confirmLabel="Delete Sequence"
        onConfirm={async () => {
          try {
            await deleteSequence(sequenceId);
            toast.success("Sequence deleted");
            if (redirectTo) router.push(redirectTo);
            else router.refresh();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to delete sequence");
          }
        }}
      />
    </>
  );
}
