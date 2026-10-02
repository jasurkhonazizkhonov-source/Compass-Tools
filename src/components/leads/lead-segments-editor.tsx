"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AirportSearchField } from "@/components/crm/airport-search";
import { DatePicker } from "@/components/crm/date-picker";
import { setLeadSegments } from "@/server/actions/leads";
import { MAX_LEAD_SEGMENTS } from "@/lib/lead-itinerary";
import type { AirportOption } from "@/server/queries/reference-data";

export type EditableSegment = {
  /** Stable React key only — never sent to the server. */
  key: string;
  from: AirportOption | null;
  to: AirportOption | null;
  /** yyyy-MM-dd, or "" when not set. */
  date: string;
};

/**
 * The ordered flight segments of a multi-city travel request: see every leg,
 * edit any of them, add another, remove one, and move them up or down. The
 * whole list is saved in one go (setLeadSegments), so the itinerary is never
 * half-saved. Only what the request actually carries is editable — airports
 * and a date; times, airlines and flight numbers belong to the quote.
 *
 * The last remaining segment cannot be removed (a multi-city request needs at
 * least one), removing any other asks for confirmation first — the same
 * window.confirm pattern the rest of the CRM's destructive controls use — and
 * nothing is persisted until Save, so an accidental edit is simply discarded
 * by reloading.
 */
export function LeadSegmentsEditor({ leadId, initialSegments }: { leadId: string; initialSegments: EditableSegment[] }) {
  // Keys for segments added in this session. A ref is only ever read in event handlers (add()), never during render.
  const counter = useRef(0);
  const newKey = () => `new-${++counter.current}`;
  const [segments, setSegments] = useState<EditableSegment[]>(initialSegments.length > 0 ? initialSegments : [{ key: "new-0", from: null, to: null, date: "" }]);
  const [saved, setSaved] = useState(JSON.stringify(strip(initialSegments)));
  const [isPending, startTransition] = useTransition();

  const dirty = JSON.stringify(strip(segments)) !== saved;

  function update(index: number, patch: Partial<EditableSegment>) {
    setSegments((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }
  function add() {
    setSegments((prev) => {
      if (prev.length >= MAX_LEAD_SEGMENTS) return prev;
      // A new leg usually starts where the previous one ended.
      const last = prev[prev.length - 1];
      return [...prev, { key: newKey(), from: last?.to ?? null, to: null, date: "" }];
    });
  }
  function remove(index: number) {
    if (segments.length <= 1) return;
    if (!window.confirm(`Remove segment ${index + 1}?\n\nThe itinerary is only changed when you press Save itinerary.`)) return;
    setSegments((prev) => prev.filter((_, i) => i !== index));
  }
  function move(index: number, delta: -1 | 1) {
    setSegments((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  function save() {
    startTransition(async () => {
      try {
        await setLeadSegments(
          leadId,
          segments.map((s) => ({ departureAirportId: s.from?.id ?? null, arrivalAirportId: s.to?.id ?? null, departureDate: s.date || null }))
        );
        setSaved(JSON.stringify(strip(segments)));
        toast.success("Itinerary saved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save the itinerary");
      }
    });
  }

  return (
    <div className="space-y-3" data-testid="lead-segments-editor">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {segments.length} flight segment{segments.length === 1 ? "" : "s"}
        </p>
        {dirty && <p className="text-xs text-amber-600">Unsaved changes</p>}
      </div>

      <ol className="space-y-3">
        {segments.map((seg, i) => (
          <li key={seg.key} className="rounded-md border p-3 space-y-3" aria-label={`Segment ${i + 1}`}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Segment {i + 1}</p>
              <div className="flex items-center gap-1">
                <Button type="button" size="icon-sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0 || isPending} aria-label={`Move segment ${i + 1} up`}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="icon-sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === segments.length - 1 || isPending} aria-label={`Move segment ${i + 1} down`}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => remove(i)}
                  disabled={segments.length <= 1 || isPending}
                  title={segments.length <= 1 ? "A multi-city request needs at least one flight segment" : undefined}
                  aria-label={`Remove segment ${i + 1}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted-foreground">From</p>
                <AirportSearchField value={seg.from} onChange={(v) => update(i, { from: v })} ariaLabel={`Segment ${i + 1} from`} />
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-xs text-muted-foreground">To</p>
                <AirportSearchField value={seg.to} onChange={(v) => update(i, { to: v })} ariaLabel={`Segment ${i + 1} to`} />
              </div>
            </div>
            <div className="space-y-1 sm:max-w-[16rem]">
              <p className="text-xs text-muted-foreground">Departure date</p>
              <DatePicker value={seg.date || null} onChange={(v) => update(i, { date: v ?? "" })} />
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={segments.length >= MAX_LEAD_SEGMENTS || isPending} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add flight segment
        </Button>
        <Button type="button" size="sm" onClick={save} disabled={!dirty || isPending} className="gap-1.5">
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save itinerary
        </Button>
      </div>
    </div>
  );
}

function strip(segments: EditableSegment[]) {
  return segments.map((s) => ({ f: s.from?.id ?? null, t: s.to?.id ?? null, d: s.date }));
}
