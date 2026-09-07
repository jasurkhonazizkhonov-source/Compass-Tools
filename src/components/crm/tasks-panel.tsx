"use client";

import { useTransition } from "react";
import { format } from "date-fns";
import { CalendarClock, Pencil } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/crm/empty-state";
import { NewTaskDialog } from "@/components/tasks/new-task-dialog";
import { cn } from "@/lib/utils";
import { toggleTask } from "@/server/actions/tasks";
import type { Priority } from "@/generated/prisma/client";

type TaskRow = {
  id: string;
  title: string;
  notes: string | null;
  priority: Priority;
  dueAt: Date | null;
  status: string;
  assignee: { id: string; fullName: string } | null;
};

type Agent = { id: string; fullName: string };

export function TasksPanel({
  contactId,
  leadId,
  tasks,
  agents,
  currentAgentId,
}: {
  contactId?: string;
  leadId?: string;
  tasks: TaskRow[];
  agents: Agent[];
  currentAgentId?: string;
}) {
  const [, startTransition] = useTransition();

  const pending = tasks.filter((t) => t.status === "PENDING");
  const completed = tasks.filter((t) => t.status === "COMPLETED");

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <NewTaskDialog
          agents={agents}
          currentAgentId={currentAgentId}
          leadId={leadId}
          contactId={contactId}
          triggerLabel="Add Task"
          triggerSize="sm"
        />
      </div>

      {tasks.length === 0 ? (
        <EmptyState icon={CalendarClock} title="No tasks yet" description="Follow-ups and reminders will show up here." />
      ) : (
        <div className="space-y-3">
          {[...pending, ...completed].map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
              <Checkbox
                checked={t.status === "COMPLETED"}
                onCheckedChange={() => startTransition(() => toggleTask(t.id, { contactId, leadId }))}
              />
              <div className="flex-1 min-w-0">
                <p className={cn("text-sm", t.status === "COMPLETED" && "line-through text-muted-foreground")}>{t.title}</p>
                {t.assignee && <p className="text-xs text-muted-foreground">{t.assignee.fullName}</p>}
              </div>
              {t.dueAt && (
                <span className="text-xs text-muted-foreground shrink-0">{format(t.dueAt, "MMM d, yyyy 'at' h:mm a")}</span>
              )}
              <NewTaskDialog
                agents={agents}
                currentAgentId={currentAgentId}
                leadId={leadId}
                contactId={contactId}
                existingTask={{
                  id: t.id,
                  title: t.title,
                  notes: t.notes,
                  priority: t.priority,
                  dueAt: t.dueAt,
                  assigneeId: t.assignee?.id ?? null,
                }}
                trigger={
                  <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Edit task">
                    <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
