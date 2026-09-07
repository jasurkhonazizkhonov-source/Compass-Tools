"use client";

import { useId, type ReactNode } from "react";
import { AlertTriangle, Trash2, Plane, CircleAlert, Link2, Unlink, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { AirportSearchField } from "@/components/crm/airport-search";
import { AirlineSearchField } from "@/components/crm/airline-search";
import { AircraftSearchField } from "@/components/crm/aircraft-search";
import { DatePicker } from "@/components/crm/date-picker";
import { formatDuration } from "@/lib/parsers/shared";
import { calculateFlightDurationMinutes } from "@/lib/flight-duration";
import { cn } from "@/lib/utils";
import type { AirportOption, AirlineOption, AircraftOption } from "@/server/queries/reference-data";
import type { ParsedFieldKey, ParsedWarning } from "@/lib/parsers/shared";

export type EditableSegment = {
  clientId: string;
  departureAirport: AirportOption | null;
  arrivalAirport: AirportOption | null;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  airline: AirlineOption | null;
  airlineCodeRaw: string;
  flightNumber: string;
  bookingClass: string;
  cabin: "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST";
  aircraft: AircraftOption | null;
  aircraftRaw: string;
  /** Free-text operating-carrier name from a parsed "OPERATED BY X" GDS
   * continuation line — airline/airlineCodeRaw above always remain the
   * marketing carrier. Empty string when not present/applicable. */
  operatingCarrierName: string;
  /** Each tagged with the single field it concerns — cleared the instant
   * that field is edited (see `set` below), instead of persisting as stale
   * text after the agent has already corrected the underlying issue. */
  warnings: ParsedWarning[];
  /** Fields the parser flagged as low-confidence — highlighted individually
   * rather than only surfaced in the generic warnings banner. Cleared as
   * the agent edits each field (see `set` below). */
  uncertainFields: ParsedFieldKey[];
  /** How this segment connects to the PREVIOUS one — undefined/null on the
   * first segment (no predecessor) and on any segment that is a separate
   * leg rather than a physical connection. */
  connectionType?: "LAYOVER" | "MULTI_CITY";
  /** A "bonus" leg included at no extra charge — hidden from the initial
   * customer quote email, shown as "Bonus Flight" once the customer clicks
   * through to View Deal/the booking form. Independent per segment,
   * unchecked by default. */
  isExtraLeg: boolean;
  /** Part 3 — an agent-entered correction to the auto-calculated duration.
   * Null (the default) means "keep auto-calculating from the departure/
   * arrival date+time" — the moment the agent edits ANY of those four
   * fields again, this is cleared back to null so the calculated value
   * becomes authoritative again (an override never silently keeps stale
   * departure/arrival times looking consistent with a duration that no
   * longer matches them). Never persisted as anything other than the
   * literal FlightSegment.durationMinutes value that gets saved either
   * way — this field only exists to remember "was this the agent's own
   * number or a computed one" for this editing session's UI. */
  durationOverrideMinutes: number | null;
};

const CABIN_CLASSES = [
  { value: "ECONOMY", label: "Economy" },
  { value: "PREMIUM_ECONOMY", label: "Premium Economy" },
  { value: "BUSINESS", label: "Business" },
  { value: "FIRST", label: "First" },
] as const;

function computeDurationMinutes(seg: EditableSegment): number | null {
  if (!seg.departureDate || !seg.departureTime || !seg.arrivalDate || !seg.arrivalTime) return null;
  const depAt = `${seg.departureDate}T${seg.departureTime}:00`;
  const arrAt = `${seg.arrivalDate}T${seg.arrivalTime}:00`;
  if (Number.isNaN(new Date(depAt).getTime()) || Number.isNaN(new Date(arrAt).getTime())) return null;
  return calculateFlightDurationMinutes(depAt, seg.departureAirport?.timezone, arrAt, seg.arrivalAirport?.timezone);
}

/** Gap between the previous segment's arrival and this one's departure —
 * full date+time math (not clock-only), so overnight/date-rollover
 * layovers come out correct the same way flight-itinerary-display.tsx
 * computes it for the customer-facing page. */
function computeLayoverMinutes(prev: EditableSegment, cur: EditableSegment): number | null {
  if (!prev.arrivalDate || !prev.arrivalTime || !cur.departureDate || !cur.departureTime) return null;
  const arrAt = `${prev.arrivalDate}T${prev.arrivalTime}:00`;
  const depAt = `${cur.departureDate}T${cur.departureTime}:00`;
  if (Number.isNaN(new Date(arrAt).getTime()) || Number.isNaN(new Date(depAt).getTime())) return null;
  const minutes = calculateFlightDurationMinutes(arrAt, prev.arrivalAirport?.timezone, depAt, cur.departureAirport?.timezone);
  return minutes >= 0 ? minutes : null;
}

/**
 * The visible <Label> here and each field's actual control (a mix of
 * native <Input>/<Select> and custom ARIA combobox buttons like
 * AirportSearchField) previously had no programmatic relationship at
 * all — a screen-reader user landing directly on a control (rather than
 * reading the page linearly) would hear only its own generic content
 * ("Search airport or city...", identical for both the From and To
 * fields) with no indication of which field it actually was. `useId()`
 * gives every FieldSlot instance a real, unique-per-render id (safe
 * across multiple flight segments, multiple builder instances on the
 * page, and re-renders — React guarantees this, unlike a hand-rolled
 * counter or the field's own key), and `children` is now a render-prop
 * so the control can receive that id and apply it via `aria-labelledby`
 * — the correct mechanism for a custom widget that isn't a native
 * "labelable" element a plain `<label for>` could target. This makes the
 * EXISTING visible label text (e.g. "From", "Airline") the one and only
 * source of the accessible name too, rather than inventing a second,
 * separately-maintained string that could drift from what's on screen.
 */
function FieldSlot({
  label,
  fieldKey,
  segment,
  extraLabel,
  children,
}: {
  label: string;
  fieldKey: ParsedFieldKey;
  segment: EditableSegment;
  extraLabel?: ReactNode;
  children: (labelId: string) => ReactNode;
}) {
  const needsReview = segment.uncertainFields.includes(fieldKey);
  const labelId = useId();
  return (
    // min-w-0 overrides the grid item's default `min-width: auto` — without
    // it, a field whose control renders `whitespace-nowrap` text (e.g. the
    // airport/airline combobox trigger's placeholder) forces this cell to
    // never shrink below that text's full width, so on a narrow (mobile)
    // viewport the two cells in each `grid-cols-1 sm:grid-cols-2` row can't
    // both fit their content-driven minimums — one collapses to near-zero
    // width (its label and control squeezed illegibly) while its sibling
    // keeps its full width. Found live during the pre-launch mobile QA pass
    // on the Exchange builder and the original Fare Quote builder (both use
    // this same FieldSlot) at 375/390/430px.
    <div className="space-y-1.5 min-w-0">
      <Label id={labelId} className="flex items-center gap-1.5">
        {label} {extraLabel}
        {needsReview && (
          <Tooltip>
            <TooltipTrigger asChild>
              <CircleAlert className="h-3 w-3 text-warning-foreground" />
            </TooltipTrigger>
            <TooltipContent>Not confidently parsed — please confirm</TooltipContent>
          </Tooltip>
        )}
      </Label>
      <div className={cn(needsReview && "rounded-md ring-1 ring-warning/50")}>{children(labelId)}</div>
    </div>
  );
}

export function FlightSegmentEditor({
  segment,
  index,
  onChange,
  onRemove,
  canRemove,
}: {
  segment: EditableSegment;
  index: number;
  onChange: (next: EditableSegment) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  // Aircraft isn't a FieldSlot (it spans both grid columns), so it needs
  // its own id for the same label/control association FieldSlot gives
  // every other field — see FieldSlot's own comment for the full reasoning.
  const aircraftLabelId = useId();

  function set<K extends keyof EditableSegment>(key: K, value: EditableSegment[K]) {
    // Editing a field is the agent confirming/correcting it — clear its
    // "needs review" flag along with the matching cabin flag when the
    // booking class itself is edited.
    const clearedKeys = new Set<ParsedFieldKey>();
    const FIELD_MAP: Partial<Record<keyof EditableSegment, ParsedFieldKey>> = {
      departureAirport: "departureAirport",
      arrivalAirport: "arrivalAirport",
      departureDate: "departureDate",
      departureTime: "departureTime",
      arrivalDate: "arrivalDate",
      arrivalTime: "arrivalTime",
      airline: "airline",
      flightNumber: "flightNumber",
      cabin: "cabin",
      bookingClass: "bookingClass",
    };
    const mapped = FIELD_MAP[key];
    if (mapped) clearedKeys.add(mapped);

    // Editing any of the four departure/arrival date+time fields again
    // reverts duration back to auto-calculated — an override must never be
    // left looking consistent with times it no longer actually matches
    // (Part 3's explicit "do not silently change departure/arrival times
    // because duration was manually edited" requirement, applied in the
    // other direction: editing the times un-does the override instead).
    const isDateOrTimeField = key === "departureDate" || key === "departureTime" || key === "arrivalDate" || key === "arrivalTime";

    onChange({
      ...segment,
      [key]: value,
      durationOverrideMinutes: isDateOrTimeField ? null : segment.durationOverrideMinutes,
      uncertainFields: segment.uncertainFields.filter((f) => !clearedKeys.has(f)),
      // Parser warnings are a per-field history, not a permanent record —
      // once the agent corrects the field a warning was about, that
      // specific warning no longer describes reality and must disappear
      // rather than keep showing a stale "could not be determined" message.
      warnings: segment.warnings.filter((w) => !clearedKeys.has(w.field)),
    });
  }

  const calculatedDuration = computeDurationMinutes(segment);
  const isOverridden = segment.durationOverrideMinutes != null;
  const duration = isOverridden ? segment.durationOverrideMinutes : calculatedDuration;
  const overnight =
    segment.departureDate && segment.arrivalDate && segment.departureDate !== segment.arrivalDate;

  return (
    <div className="rounded-lg border p-4 space-y-4 relative">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <Plane className="h-3.5 w-3.5" /> Flight {index + 1}
        </p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <Checkbox
              checked={segment.isExtraLeg}
              onCheckedChange={(checked) => set("isExtraLeg", checked === true)}
            />
            Extra Leg
          </label>
          {canRemove && (
            <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove this flight">
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          )}
        </div>
      </div>
      {segment.isExtraLeg && (
        <p className="text-xs text-info bg-info/10 border border-info/30 rounded-md px-3 py-1.5">
          Marked as an Extra Leg — this flight will be hidden from the initial customer quote email and shown as a &quot;Bonus Flight&quot; once the customer opens View Deal.
        </p>
      )}

      {segment.warnings.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground shrink-0 mt-0.5" />
          <div>
            {segment.warnings.map((w, i) => (
              <p key={i}>{w.message}</p>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 [&>*]:min-w-0 [&>*]:w-full sm:[&>*]:w-[calc(50%-0.375rem)]">
        <FieldSlot label="From" fieldKey="departureAirport" segment={segment}>
          {(labelId) => <AirportSearchField value={segment.departureAirport} onChange={(v) => set("departureAirport", v)} aria-labelledby={labelId} />}
        </FieldSlot>
        <FieldSlot label="To" fieldKey="arrivalAirport" segment={segment}>
          {(labelId) => <AirportSearchField value={segment.arrivalAirport} onChange={(v) => set("arrivalAirport", v)} aria-labelledby={labelId} />}
        </FieldSlot>

        <FieldSlot label="Departure Date" fieldKey="departureDate" segment={segment}>
          {(labelId) => <DatePicker value={segment.departureDate || null} onChange={(v) => set("departureDate", v ?? "")} aria-labelledby={labelId} />}
        </FieldSlot>
        <FieldSlot label="Departure Time" fieldKey="departureTime" segment={segment}>
          {(labelId) => <Input type="time" value={segment.departureTime} onChange={(e) => set("departureTime", e.target.value)} aria-labelledby={labelId} />}
        </FieldSlot>

        <FieldSlot
          label="Arrival Date"
          fieldKey="arrivalDate"
          segment={segment}
          extraLabel={overnight && <span className="text-warning-foreground text-xs">(next day)</span>}
        >
          {(labelId) => <DatePicker value={segment.arrivalDate || null} onChange={(v) => set("arrivalDate", v ?? "")} aria-labelledby={labelId} />}
        </FieldSlot>
        <FieldSlot label="Arrival Time" fieldKey="arrivalTime" segment={segment}>
          {(labelId) => <Input type="time" value={segment.arrivalTime} onChange={(e) => set("arrivalTime", e.target.value)} aria-labelledby={labelId} />}
        </FieldSlot>

        <FieldSlot label="Airline" fieldKey="airline" segment={segment}>
          {(labelId) => <AirlineSearchField value={segment.airline} onChange={(v) => set("airline", v)} aria-labelledby={labelId} />}
        </FieldSlot>
        <FieldSlot label="Flight Number" fieldKey="flightNumber" segment={segment}>
          {(labelId) => <Input value={segment.flightNumber} onChange={(e) => set("flightNumber", e.target.value)} placeholder="e.g. 1460" aria-labelledby={labelId} />}
        </FieldSlot>

        <FieldSlot label="Cabin" fieldKey="cabin" segment={segment}>
          {(labelId) => (
            <Select value={segment.cabin} onValueChange={(v) => set("cabin", v as EditableSegment["cabin"])}>
              <SelectTrigger className="w-full" aria-labelledby={labelId}><SelectValue /></SelectTrigger>
              <SelectContent>
                {CABIN_CLASSES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </FieldSlot>
        <FieldSlot label="Booking Class" fieldKey="bookingClass" segment={segment}>
          {(labelId) => <Input value={segment.bookingClass} onChange={(e) => set("bookingClass", e.target.value.toUpperCase())} maxLength={2} placeholder="e.g. Y" aria-labelledby={labelId} />}
        </FieldSlot>

        <div className="space-y-1.5 col-span-2">
          <Label id={aircraftLabelId}>Aircraft</Label>
          <AircraftSearchField value={segment.aircraft} onChange={(v) => set("aircraft", v)} aria-labelledby={aircraftLabelId} />
          {!segment.aircraft && segment.aircraftRaw && (
            <p className="text-xs text-muted-foreground">Parsed equipment code &quot;{segment.aircraftRaw}&quot; — select the matching aircraft above.</p>
          )}
        </div>
      </div>

      {/* Pass 13 §3/§4 — hours + minutes is the primary editing surface, not
          raw total minutes ("208 minutes" is not how anyone thinks about a
          flight's length). Internally this is still exactly one number —
          durationOverrideMinutes, in minutes, unchanged — calculateJourneyDuration
          and every other consumer downstream never learn hours/minutes were
          ever involved; this component is the ONLY place that converts. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs">
        <span className="text-muted-foreground flex items-center gap-1.5">
          Flight duration
          {isOverridden ? (
            <span className="text-warning-foreground font-medium">(manually set)</span>
          ) : (
            <span className="text-muted-foreground/70">(calculated)</span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <DurationHoursMinutesInput
            totalMinutes={duration}
            onChange={(nextMinutes) => onChange({ ...segment, durationOverrideMinutes: nextMinutes })}
          />
          {isOverridden && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6"
                  onClick={() => onChange({ ...segment, durationOverrideMinutes: null })}
                  aria-label="Reset to calculated duration"
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Reset to calculated duration</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Pass 13 §3 — the hours/minutes editing pair. Two small number inputs
 * (Hours: any non-negative integer up to the existing 1440-minute/24h cap;
 * Minutes: strictly 0–59, matching a real clock, never "enter 208 minutes")
 * that together represent ONE underlying total-minutes value — this
 * component is the only place that ever splits/recombines it. Malformed
 * input (blank, negative, non-numeric, out-of-range) is clamped to the
 * nearest valid value rather than producing NaN or a rejected keystroke,
 * consistent with how every other numeric field in this builder already
 * behaves (e.g. the pre-existing 1–1440 total-minutes clamp this replaces).
 */
function DurationHoursMinutesInput({ totalMinutes, onChange }: { totalMinutes: number | null; onChange: (minutes: number | null) => void }) {
  const hours = totalMinutes != null ? Math.floor(totalMinutes / 60) : null;
  const minutes = totalMinutes != null ? totalMinutes % 60 : null;

  function commit(nextHours: number, nextMinutes: number) {
    const clampedMinutes = Math.max(0, Math.min(59, Math.trunc(nextMinutes) || 0));
    const clampedHours = Math.max(0, Math.trunc(nextHours) || 0);
    // No artificial floor here (0h 0m passes through as 0) — an
    // intermediate 0 while the agent is still typing a new value (e.g.
    // clearing Hours before typing "19") must never get silently bumped
    // up to a nonzero total that then contaminates the next keystroke.
    const total = Math.min(1440, clampedHours * 60 + clampedMinutes);
    onChange(total);
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        aria-label="Flight duration — hours"
        className="h-7 w-12 text-xs text-right tabular-nums"
        value={hours ?? ""}
        placeholder="0"
        onChange={(e) => {
          // An empty field commits as 0 for that unit, never as "clear the
          // whole override back to calculated" — that's what the explicit
          // Reset button is for. Treating a momentarily-empty field as a
          // full reset would make typing a new value (which passes through
          // an empty intermediate state) unpredictable.
          const raw = e.target.value;
          commit(raw === "" ? 0 : Number(raw), minutes ?? 0);
        }}
      />
      <span className="text-muted-foreground">h</span>
      <Input
        type="number"
        inputMode="numeric"
        min={0}
        max={59}
        step={1}
        aria-label="Flight duration — minutes"
        className="h-7 w-12 text-xs text-right tabular-nums"
        value={minutes ?? ""}
        placeholder="0"
        onChange={(e) => {
          const raw = e.target.value;
          commit(hours ?? 0, raw === "" ? 0 : Number(raw));
        }}
      />
      <span className="text-muted-foreground">m</span>
    </div>
  );
}

/**
 * Sits between two flight segments in the manual builder — lets the agent
 * mark whether the next segment is a connecting/layover flight (rendered
 * joined on the customer quote) or a separate leg (rendered as a distinct
 * multi-city flight, no layover shown). Controls
 * `FlightItineraryDisplay`'s grouping on the customer-facing side.
 */
export function SegmentConnector({
  value,
  onChange,
  previousSegment,
  currentSegment,
}: {
  value: "LAYOVER" | "MULTI_CITY" | undefined;
  onChange: (next: "LAYOVER" | "MULTI_CITY" | undefined) => void;
  /** Adjacent segments — used to compute and display the layover duration
   * when this connection is a LAYOVER. Never shown for MULTI_CITY, which
   * represents separate journeys rather than a connection. */
  previousSegment: EditableSegment;
  currentSegment: EditableSegment;
}) {
  const isLayover = value === "LAYOVER";
  const layoverMinutes = isLayover ? computeLayoverMinutes(previousSegment, currentSegment) : null;
  return (
    <div className="flex items-center gap-3 pl-4">
      <div className="flex flex-col items-center gap-1 py-1">
        <div className="h-3 w-px bg-border" />
        {isLayover ? <Link2 className="h-3.5 w-3.5 text-info" /> : <Unlink className="h-3.5 w-3.5 text-muted-foreground" />}
        <div className="h-3 w-px bg-border" />
      </div>
      <div className="flex rounded-md border p-0.5 text-xs">
        <button
          type="button"
          onClick={() => onChange("LAYOVER")}
          className={cn(
            "rounded-[5px] px-2.5 py-1 font-medium transition-colors",
            isLayover ? "bg-info/15 text-info" : "text-muted-foreground hover:text-foreground"
          )}
        >
          Layover
        </button>
        <button
          type="button"
          onClick={() => onChange("MULTI_CITY")}
          className={cn(
            "rounded-[5px] px-2.5 py-1 font-medium transition-colors",
            !isLayover ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          Multi City
        </button>
      </div>
      {isLayover && layoverMinutes !== null ? (
        <span className="text-xs font-medium text-info">Layover {formatDuration(layoverMinutes)}</span>
      ) : (
        <span className="text-xs text-muted-foreground">
          {isLayover ? "Shown as one connected journey with a layover" : "Shown as a separate flight leg"}
        </span>
      )}
    </div>
  );
}
