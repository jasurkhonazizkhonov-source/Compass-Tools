"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { enrollLeads } from "@/server/actions/sequences";

type LeadOption = { id: string; name: string; route: string; status: string };

export function EnrollLeadsDialog({ sequenceId, leads }: { sequenceId: string; leads: LeadOption[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const filtered = leads.filter(
    (l) => l.name.toLowerCase().includes(query.toLowerCase()) || l.route.toLowerCase().includes(query.toLowerCase())
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit() {
    if (selected.size === 0) {
      toast.error("Select at least one lead");
      return;
    }
    startTransition(async () => {
      const result = await enrollLeads(sequenceId, [...selected]);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`Enrolled ${result.enrolled} lead${result.enrolled === 1 ? "" : "s"}${result.skipped ? ` (${result.skipped} already enrolled)` : ""}`);
      setOpen(false);
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2"><UserPlus className="h-4 w-4" /> Enroll Leads</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Enroll Leads</DialogTitle>
          <DialogDescription>Select leads to enroll in this sequence. Each will receive personalized emails.</DialogDescription>
        </DialogHeader>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search leads..." />
        <ScrollArea className="h-72 rounded-md border">
          <div className="p-2 space-y-1">
            {filtered.length === 0 && <p className="text-sm text-muted-foreground p-4 text-center">No leads found</p>}
            {filtered.map((l) => (
              <label key={l.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 text-sm cursor-pointer">
                <Checkbox checked={selected.has(l.id)} onCheckedChange={() => toggle(l.id)} />
                <span className="flex-1">{l.name}</span>
                <span className="text-xs text-muted-foreground">{l.route}</span>
              </label>
            ))}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={isPending} className="gap-2">
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Enroll {selected.size > 0 ? selected.size : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
