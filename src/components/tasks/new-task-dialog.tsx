"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateTimePicker } from "@/components/crm/datetime-picker";
import { LeadSearchField, type LeadOption } from "@/components/tasks/lead-search-field";
import { createTask, updateTask } from "@/server/actions/tasks";
import { PRIORITY_META } from "@/lib/status-meta";
import type { Priority } from "@/generated/prisma/client";

type Agent = { id: string; fullName: string };
const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH"];

export type EditableTask = {
  id: string;
  title: string;
  notes: string | null;
  priority: Priority;
  dueAt: Date | null;
  assigneeId: string | null;
};

export function NewTaskDialog({
  agents,
  currentAgentId,
  leadId,
  contactId,
  triggerLabel = "New Task",
  triggerSize = "default",
  trigger,
  existingTask,
}: {
  agents: Agent[];
  currentAgentId?: string;
  /** When provided, the task is created against this lead/contact directly
   * and the "Related lead" search field is hidden — used when this dialog
   * is embedded inside a lead or contact's own page, where the relation is
   * already known. Omit both to show the search field (main Tasks page). */
  leadId?: string;
  contactId?: string;
  triggerLabel?: string;
  triggerSize?: "default" | "sm";
  /** Custom trigger element (e.g. a small pencil icon button for inline
   * editing) — overrides the default "+ New Task" button when provided. */
  trigger?: React.ReactNode;
  /** When provided, the dialog opens pre-filled for this task and saves via
   * updateTask() instead of createTask() — the exact same field set and
   * form, just editing instead of creating. Reused as-is by TasksPanel's
   * per-row edit button so there's one task form, not two. */
  existingTask?: EditableTask;
}) {
  const isEditMode = Boolean(existingTask);
  const presetRelation = Boolean(leadId || contactId);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(existingTask?.title ?? "");
  const [notes, setNotes] = useState(existingTask?.notes ?? "");
  const [priority, setPriority] = useState<Priority>(existingTask?.priority ?? "MEDIUM");
  const [dueAt, setDueAt] = useState<string | null>(existingTask?.dueAt ? existingTask.dueAt.toISOString() : null);
  const [assigneeId, setAssigneeId] = useState<string | undefined>(existingTask?.assigneeId ?? currentAgentId);
  const [lead, setLead] = useState<LeadOption | null>(null);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setTitle(existingTask?.title ?? "");
    setNotes(existingTask?.notes ?? "");
    setPriority(existingTask?.priority ?? "MEDIUM");
    setDueAt(existingTask?.dueAt ? existingTask.dueAt.toISOString() : null);
    setAssigneeId(existingTask?.assigneeId ?? currentAgentId);
    setLead(null);
  }

  function submit() {
    if (!title.trim()) {
      toast.error("Task title is required");
      return;
    }
    startTransition(async () => {
      if (existingTask) {
        await updateTask({
          taskId: existingTask.id,
          title: title.trim(),
          notes: notes.trim() || null,
          priority,
          dueAt: dueAt || null,
          assigneeId: assigneeId || null,
        });
        toast.success("Task updated");
      } else {
        await createTask({
          title: title.trim(),
          notes: notes.trim() || undefined,
          priority,
          dueAt: dueAt || undefined,
          assigneeId,
          leadId: presetRelation ? leadId : lead?.id,
          contactId: presetRelation ? contactId : lead?.contactId,
        });
        toast.success("Task created");
      }
      reset();
      setOpen(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button className="gap-1.5" size={triggerSize}>
            <Plus className="h-4 w-4" /> {triggerLabel}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditMode ? "Edit Task" : "New Task"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Call customer about upgrade options" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Any extra context for this task..." />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Due date & time</Label>
            <DateTimePicker value={dueAt} onChange={setDueAt} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Assign to</Label>
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select agent" /></SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!presetRelation && (
            <div className="space-y-1.5">
              <Label className="text-xs">Related lead</Label>
              <LeadSearchField value={lead} onChange={setLead} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>Cancel</Button>
          <Button onClick={submit} disabled={isPending} className="gap-1.5">
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isEditMode ? "Save Changes" : "Create Task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
