"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { format } from "date-fns";
import { Pencil, Check, X, Loader2, Trash2, CheckCircle2, RotateCcw, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateTimePicker } from "@/components/crm/datetime-picker";
import { CountdownBadge } from "@/components/crm/countdown-badge";
import { StatusBadge } from "@/components/crm/status-badge";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { updateTask, toggleTask, deleteTask, reassignTask } from "@/server/actions/tasks";
import { cn } from "@/lib/utils";
import { PRIORITY_META } from "@/lib/status-meta";
import type { Priority } from "@/generated/prisma/client";

type Agent = { id: string; fullName: string };
const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH"];

type TaskDetail = {
  id: string;
  title: string;
  notes: string | null;
  priority: Priority;
  dueAt: Date | null;
  status: "PENDING" | "COMPLETED";
  createdAt: Date;
  completedAt: Date | null;
  assignee: { id: string; fullName: string } | null;
  completedBy: { id: string; fullName: string } | null;
  contact: { id: string; firstName: string; lastName: string } | null;
  lead: {
    id: string;
    contact: { id: string; firstName: string; lastName: string };
    departureAirport: { iata: string } | null;
    arrivalAirport: { iata: string } | null;
  } | null;
};

export function TaskDetailPanel({ task, agents }: { task: TaskDetail; agents: Agent[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [dueAt, setDueAt] = useState<string | null>(task.dueAt ? task.dueAt.toISOString() : null);
  const [isPending, startTransition] = useTransition();
  const [isToggling, startToggleTransition] = useTransition();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const relatedContact = task.contact ?? task.lead?.contact ?? null;
  const relatedHref = task.lead ? `/leads/${task.lead.id}` : task.contact ? `/contacts/${task.contact.id}` : null;

  function save() {
    startTransition(async () => {
      await updateTask({ taskId: task.id, title, notes: notes || null, priority, dueAt });
      setEditing(false);
      toast.success("Task updated");
    });
  }

  function cancelEdit() {
    setTitle(task.title);
    setNotes(task.notes ?? "");
    setPriority(task.priority);
    setDueAt(task.dueAt ? task.dueAt.toISOString() : null);
    setEditing(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="text-lg font-semibold h-10" />
          ) : (
            <h1 className={cn("text-2xl font-semibold tracking-tight", task.status === "COMPLETED" && "line-through text-muted-foreground")}>
              {task.title}
            </h1>
          )}
          <div className="flex items-center gap-2 mt-2">
            <CountdownBadge dueAt={task.dueAt} status={task.status} />
            {editing ? (
              <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
                <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <StatusBadge label={`${PRIORITY_META[task.priority].label} Priority`} tone={PRIORITY_META[task.priority].tone} />
            )}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          {!editing ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="gap-1.5">
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          ) : (
            <>
              <Button variant="outline" size="icon" onClick={save} disabled={isPending} aria-label="Save task">
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="icon" onClick={cancelEdit} disabled={isPending} aria-label="Cancel editing task">
                <X className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="rounded-xl border bg-card p-5 space-y-4">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Notes</Label>
          {editing ? (
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Add notes..." />
          ) : (
            <p className="text-sm whitespace-pre-wrap">{task.notes || <span className="text-muted-foreground italic">No notes</span>}</p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Due date & time</Label>
            {editing ? (
              <DateTimePicker value={dueAt} onChange={setDueAt} />
            ) : (
              <p className="text-sm">{task.dueAt ? format(task.dueAt, "MMM d, yyyy 'at' h:mm a") : <span className="text-muted-foreground">No due date</span>}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Assigned to</Label>
            <Select
              value={task.assignee?.id ?? "unassigned"}
              onValueChange={(v) => startTransition(async () => {
                await reassignTask(task.id, v);
                toast.success("Task reassigned");
                router.refresh();
              })}
            >
              <SelectTrigger className="w-full">
                <span className="flex items-center gap-1.5"><UserIcon className="h-3.5 w-3.5 text-muted-foreground" /><SelectValue /></span>
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Related to</Label>
            {relatedContact && relatedHref ? (
              <Link href={relatedHref} className="text-sm font-medium text-primary hover:underline block">
                {relatedContact.firstName} {relatedContact.lastName}
                {task.lead?.departureAirport && task.lead?.arrivalAirport && (
                  <span className="text-muted-foreground font-normal"> · {task.lead.departureAirport.iata} → {task.lead.arrivalAirport.iata}</span>
                )}
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">Not linked to a customer</p>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Created</Label>
            <p className="text-sm text-muted-foreground">{format(task.createdAt, "MMM d, yyyy 'at' h:mm a")}</p>
          </div>
          {task.status === "COMPLETED" && task.completedAt && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Completed</Label>
              <p className="text-sm text-muted-foreground">
                {format(task.completedAt, "MMM d, yyyy 'at' h:mm a")}
                {task.completedBy && <> by {task.completedBy.fullName}</>}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant={task.status === "COMPLETED" ? "outline" : "default"}
          className="gap-1.5"
          disabled={isToggling}
          onClick={() => startToggleTransition(async () => {
            await toggleTask(task.id);
            toast.success(task.status === "COMPLETED" ? "Task reopened" : "Task completed");
            router.refresh();
          })}
        >
          {isToggling ? <Loader2 className="h-4 w-4 animate-spin" /> : task.status === "COMPLETED" ? <RotateCcw className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          {task.status === "COMPLETED" ? "Reopen Task" : "Mark Complete"}
        </Button>
        <Button variant="ghost" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
          <Trash2 className="h-4 w-4" /> Delete
        </Button>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this task?"
        description={`"${task.title}" will be permanently deleted. This can't be undone.`}
        confirmLabel="Delete Task"
        onConfirm={async () => {
          await deleteTask(task.id);
          toast.success("Task deleted");
          router.push("/tasks");
        }}
      />
    </div>
  );
}
