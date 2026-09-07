"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { toggleTask, deleteTask } from "@/server/actions/tasks";

export function TaskCompleteCheckbox({ taskId, status }: { taskId: string; status: "PENDING" | "COMPLETED" }) {
  const [isPending, startTransition] = useTransition();
  return (
    <Checkbox
      checked={status === "COMPLETED"}
      disabled={isPending}
      onCheckedChange={() => startTransition(() => toggleTask(taskId))}
      aria-label={status === "COMPLETED" ? "Reopen task" : "Complete task"}
    />
  );
}

export function TaskDeleteButton({ taskId, title }: { taskId: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Delete task"
        aria-label="Delete task"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this task?"
        description={`"${title}" will be permanently deleted. This can't be undone.`}
        confirmLabel="Delete Task"
        onConfirm={async () => {
          await deleteTask(taskId);
          toast.success("Task deleted");
        }}
      />
    </>
  );
}
