"use client";

import { useEffect, useState, useTransition } from "react";
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
import { enrollLeads, type EnrollLeadsResult } from "@/server/actions/sequences";
import { enrollLeadsByStatus, previewEnrollByStatus, type EnrollByStatusPreview, type EnrollByStatusResult } from "@/server/actions/sequence-status-enroll";
import { LEAD_STATUS_META, LEAD_STATUS_ORDER } from "@/lib/status-meta";

type LeadOption = { id: string; name: string; route: string; status: string };
type Mode = "pick" | "status";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** One short sentence for the "pick leads" toast: what was enrolled, and every reason something was not. */
function pickSummary(r: EnrollLeadsResult): string {
  const notes = [
    r.alreadyActive && `${r.alreadyActive} already enrolled`,
    r.missingEmail && `${r.missingEmail} without an email address`,
    r.noAssignedAgent && `${r.noAssignedAgent} without an assigned agent`,
    r.gmailUnavailable && `${r.gmailUnavailable} blocked because Gmail is unavailable`,
    r.inaccessible && `${r.inaccessible} not available`,
  ].filter(Boolean);
  return `Enrolled ${plural(r.enrolled, "lead")}${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

export function EnrollLeadsDialog({ sequenceId, sequenceName, leads }: { sequenceId: string; sequenceName?: string; leads: LeadOption[] }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("pick");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [previewState, setPreviewState] = useState<{ key: string; data: EnrollByStatusPreview } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<EnrollByStatusResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const filtered = leads.filter(
    (l) => l.name.toLowerCase().includes(query.toLowerCase()) || l.route.toLowerCase().includes(query.toLowerCase())
  );

  // The server counts the leads that currently match the chosen statuses (inside the caller's own visibility) with the same rules the enrollment
  // uses. The result is stored with the selection it was computed for, so a stale answer is never shown for a newer selection.
  const statusKey = [...statuses].sort().join(",");
  useEffect(() => {
    if (!open || mode !== "status" || !statusKey) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const data = await previewEnrollByStatus({ sequenceId, statuses: statusKey.split(",") });
      if (!stale) setPreviewState({ key: statusKey, data });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, mode, statusKey, sequenceId]);
  const preview = statusKey && previewState?.key === statusKey ? previewState.data : null;
  const loadingPreview = !!statusKey && !preview;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleStatus(s: string) {
    setConfirming(false);
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }
  function reset() {
    setSelected(new Set());
    setStatuses(new Set());
    setPreviewState(null);
    setConfirming(false);
    setOutcome(null);
    setQuery("");
  }

  function submitPick() {
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
      toast.success(pickSummary(result));
      setOpen(false);
      reset();
      router.refresh();
    });
  }

  function submitStatus() {
    startTransition(async () => {
      const result = await enrollLeadsByStatus({ sequenceId, statuses: [...statuses], previewMatched: preview && preview.ok ? preview.matched : undefined });
      setConfirming(false);
      setOutcome(result);
      if (result.ok) router.refresh();
    });
  }

  const eligible = preview && preview.ok && !preview.truncated ? preview.eligible : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2"><UserPlus className="h-4 w-4" /> Enroll Leads</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Enroll Leads</DialogTitle>
          <DialogDescription>
            {sequenceName ? <>Enroll leads in <strong>{sequenceName}</strong>. </> : null}
            Each enrolled lead receives the sequence&apos;s personalized emails.
          </DialogDescription>
        </DialogHeader>

        {!outcome && (
          <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="How to choose leads">
            <Button type="button" size="sm" variant={mode === "pick" ? "secondary" : "ghost"} aria-pressed={mode === "pick"} onClick={() => { setMode("pick"); setConfirming(false); }}>
              Choose leads
            </Button>
            <Button type="button" size="sm" variant={mode === "status" ? "secondary" : "ghost"} aria-pressed={mode === "status"} onClick={() => { setMode("status"); setConfirming(false); }}>
              By status
            </Button>
          </div>
        )}

        {mode === "pick" && !outcome && (
          <>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search leads..." aria-label="Search leads" />
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
              <Button onClick={submitPick} disabled={isPending} className="gap-2">
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Enroll {selected.size > 0 ? selected.size : ""}
              </Button>
            </DialogFooter>
          </>
        )}

        {mode === "status" && !outcome && (
          <>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Lead status</legend>
              <p className="text-xs text-muted-foreground">
                Choose one or more statuses. Only leads whose <em>current</em> status is one of these, and who can actually receive the emails, are enrolled.
              </p>
              <ScrollArea className="h-48 rounded-md border">
                <div className="grid grid-cols-1 gap-0.5 p-2 sm:grid-cols-2">
                  {LEAD_STATUS_ORDER.map((s) => (
                    <label key={s} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 text-sm cursor-pointer">
                      <Checkbox checked={statuses.has(s)} onCheckedChange={() => toggleStatus(s)} />
                      <span>{LEAD_STATUS_META[s].label}</span>
                    </label>
                  ))}
                </div>
              </ScrollArea>
              <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => { setStatuses(new Set()); setConfirming(false); }} disabled={statuses.size === 0}>
                Clear selection
              </Button>
            </fieldset>

            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1" aria-live="polite" data-testid="status-preview">
              {statuses.size === 0 && <p className="text-muted-foreground">Select at least one status to see how many leads match.</p>}
              {loadingPreview && (
                <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Counting matching leads...</p>
              )}
              {preview && !preview.ok && <p className="text-destructive">{preview.error}</p>}
              {preview && preview.ok && preview.truncated && (
                <p className="text-destructive">Too many leads match these statuses to check at once. Choose fewer statuses.</p>
              )}
              {preview && preview.ok && !preview.truncated && (
                <>
                  <p>
                    <strong>{plural(preview.matched, "lead")}</strong> currently match; <strong>{preview.eligible.toLocaleString("en-US")}</strong> can be enrolled in{" "}
                    <strong>{preview.sequenceName}</strong>.
                  </p>
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    {preview.alreadyActive > 0 && <li>{plural(preview.alreadyActive, "lead")} already actively enrolled</li>}
                    {preview.missingEmail > 0 && <li>{plural(preview.missingEmail, "lead")} without an email address</li>}
                    {preview.noAssignedAgent > 0 && <li>{plural(preview.noAssignedAgent, "lead")} without an assigned agent</li>}
                    {preview.gmailUnavailable > 0 && <li>{plural(preview.gmailUnavailable, "lead")} blocked because Gmail is unavailable{preview.gmailMessage ? ` - ${preview.gmailMessage}` : ""}</li>}
                  </ul>
                </>
              )}
            </div>

            {confirming && preview && preview.ok && (
              <div role="alertdialog" aria-label="Confirm enrollment" className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm space-y-2">
                <p>
                  Enroll <strong>{plural(eligible, "lead")}</strong> in <strong>{preview.sequenceName}</strong>? Eligibility is checked again on the server when you confirm.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={submitStatus} disabled={isPending} className="gap-2">
                    {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Confirm enrollment
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={isPending}>Back</Button>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              {!confirming && (
                <Button onClick={() => setConfirming(true)} disabled={isPending || !preview || !preview.ok || preview.truncated || eligible === 0}>
                  Review {eligible > 0 ? `(${eligible.toLocaleString("en-US")})` : ""}
                </Button>
              )}
            </DialogFooter>
          </>
        )}

        {outcome && (
          <div className="space-y-3" data-testid="status-outcome">
            {!outcome.ok ? (
              <p className="text-sm text-destructive" role="alert">{outcome.error}</p>
            ) : (
              <>
                <p className="text-sm" role="status">
                  <strong>{plural(outcome.enrolled, "lead")}</strong> enrolled in <strong>{outcome.sequenceName}</strong> out of {plural(outcome.matched, "matching lead")}.
                </p>
                <ul className="text-sm space-y-0.5">
                  <li>Successfully enrolled: {outcome.enrolled.toLocaleString("en-US")}</li>
                  {outcome.alreadyActive > 0 && <li>Already actively enrolled: {outcome.alreadyActive.toLocaleString("en-US")}</li>}
                  {outcome.gmailUnavailable > 0 && <li>Not enrolled because Gmail is unavailable: {outcome.gmailUnavailable.toLocaleString("en-US")}{outcome.gmailMessage ? ` - ${outcome.gmailMessage}` : ""}</li>}
                  {outcome.missingEmail > 0 && <li>Missing email address: {outcome.missingEmail.toLocaleString("en-US")}</li>}
                  {outcome.noAssignedAgent > 0 && <li>No assigned agent: {outcome.noAssignedAgent.toLocaleString("en-US")}</li>}
                  {outcome.changedSincePreview > 0 && <li>Status changed since the preview ({outcome.changedSincePreview.toLocaleString("en-US")} fewer or more leads matched than previewed)</li>}
                  {outcome.inaccessible > 0 && <li>No longer accessible: {outcome.inaccessible.toLocaleString("en-US")}</li>}
                  {outcome.failedOther > 0 && <li>Failed for another reason: {outcome.failedOther.toLocaleString("en-US")} - please try again</li>}
                </ul>
              </>
            )}
            <DialogFooter>
              <Button onClick={() => { setOpen(false); reset(); }}>Close</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
