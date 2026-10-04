"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { changeManagerTeam } from "@/server/actions/accounts";

export type TeamCandidate = {
  id: string;
  fullName: string;
  /** The manager this agent is currently on the team of, if any. */
  managerId: string | null;
  managerName: string | null;
  hidden: boolean;
  inactive: boolean;
};

/**
 * Admin control for a Manager's explicit team. Only Travel Agents are offered
 * (the server enforces the same rule — this list is a convenience, never the
 * check), and an agent can belong to one Manager only: ticking an agent who is
 * on someone else's team says so and moves them on Save.
 *
 * A Manager sees only their own records plus these agents' records, so this
 * is the control that decides that reach.
 */
export function ManagerTeamEditor({ managerId, managerName, candidates, initialMemberIds }: { managerId: string; managerName: string; candidates: TeamCandidate[]; initialMemberIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string[]>(initialMemberIds);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialMemberIds));
  const [isPending, startTransition] = useTransition();

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const dirty = saved.length !== selected.size || saved.some((id) => !selected.has(id));

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function save() {
    const ids = [...selected];
    // Send only what THIS Admin changed (relative to the team shown when this popover was
    // opened) — never the whole list. An agent they did not touch is not read or written,
    // so a stale snapshot can never undo a change made elsewhere in the meantime.
    const add = ids.filter((id) => !saved.includes(id));
    const remove = saved.filter((id) => !selected.has(id));
    startTransition(async () => {
      try {
        await changeManagerTeam(managerId, { add, remove });
        setSaved(ids);
        toast.success(`${managerName}'s team updated`);
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update the team");
      }
    });
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSelected(new Set(saved));
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" aria-label={`Edit ${managerName}'s team`} className="flex flex-wrap items-center gap-1 max-w-[260px] text-left">
          {saved.length === 0 ? (
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <Users className="h-3.5 w-3.5" /> No team members
            </span>
          ) : (
            saved.map((id) => (
              <Badge key={id} variant="outline" className="text-[10px] font-normal">
                {byId.get(id)?.fullName ?? "Unknown"}
              </Badge>
            ))
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <p className="text-xs font-medium mb-1">{managerName}&apos;s team</p>
        <p className="text-xs text-muted-foreground mb-2">
          Only Travel Agents can be team members. The Manager sees their own leads, contacts, quotes and bookings plus these agents&apos; — nobody else&apos;s. An agent can be on one team only.
        </p>
        <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
          {candidates.length === 0 && <p className="text-sm text-muted-foreground">There are no Travel Agents to assign.</p>}
          {candidates.map((c) => {
            const elsewhere = c.managerId && c.managerId !== managerId;
            return (
              <label key={c.id} className="flex items-start gap-2 text-sm">
                <Checkbox checked={selected.has(c.id)} disabled={isPending} onCheckedChange={(v) => toggle(c.id, v === true)} className="mt-0.5" />
                <span className="min-w-0 break-words">
                  {c.fullName}
                  {c.hidden && <span className="text-xs text-muted-foreground"> · hidden</span>}
                  {c.inactive && <span className="text-xs text-muted-foreground"> · inactive</span>}
                  {elsewhere && <span className="block text-xs text-amber-600">On {c.managerName ?? "another manager"}&apos;s team — saving moves them here</span>}
                </span>
              </label>
            );
          })}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSelected(new Set(saved));
              setOpen(false);
            }}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={isPending || !dirty} className="gap-1.5">
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save team
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
