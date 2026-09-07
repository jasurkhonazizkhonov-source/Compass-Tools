"use client";

import { useState } from "react";
import { format, parseISO, isValid } from "date-fns";
import { CalendarIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function toDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = parseISO(value);
  return isValid(d) ? d : undefined;
}

function toIso(date: Date | undefined): string | null {
  if (!date) return null;
  return format(date, "yyyy-MM-dd");
}

/**
 * A single-date picker: a text trigger button showing the formatted date,
 * opening a popover with the shared shadcn Calendar. Replaces bare
 * `<input type="date">` fields throughout the app with a consistent,
 * animated, theme-aware control.
 */
export function DatePicker({
  value,
  onChange,
  placeholder = "Select date",
  disabled,
  minDate,
  maxDate,
  className,
  clearable = true,
  captionLayout = "label",
  startMonth,
  portalContainer,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  minDate?: Date;
  maxDate?: Date;
  className?: string;
  clearable?: boolean;
  /** "dropdown" swaps the month/year caption for direct-select dropdowns —
   * for date-of-birth-style fields where the date may be decades in the
   * past and month-by-month navigation is impractical. Defaults to the
   * existing prev/next "label" caption everywhere else. */
  captionLayout?: "label" | "dropdown";
  /** Earliest month the year dropdown reaches. Defaults to 100 years back
   * (react-day-picker's own default for dropdown mode) when omitted. */
  startMonth?: Date;
  /** Portal target for the popover — needed on customer-facing pages so the
   * calendar renders inside the page's scoped light/dark theme wrapper
   * instead of escaping to document.body. Omit for CRM usage (unaffected). */
  portalContainer?: HTMLElement | null;
  /** Id of an existing, already-rendered visible label to derive the
   * accessible name from (see flight-segment-editor.tsx's FieldSlot) —
   * this trigger button is a custom widget, not a native input a plain
   * `<label for>` could target implicitly. Omitting it preserves every
   * pre-existing call site's behavior unchanged. */
  "aria-labelledby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = toDate(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-labelledby={ariaLabelledBy}
          className={cn("w-full justify-between font-normal", !selected && "text-muted-foreground", className)}
        >
          <span className="flex items-center gap-2 truncate">
            <CalendarIcon className="h-3.5 w-3.5 shrink-0" />
            {selected ? format(selected, "MMM d, yyyy") : placeholder}
          </span>
          {clearable && selected && (
            <span
              role="button"
              tabIndex={-1}
              className="rounded-sm opacity-60 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" container={portalContainer}>
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected ?? maxDate}
          captionLayout={captionLayout}
          startMonth={startMonth}
          endMonth={maxDate}
          onSelect={(date) => {
            onChange(toIso(date));
            setOpen(false);
          }}
          disabled={(date) => (minDate && date < minDate) || (maxDate && date > maxDate) || false}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * A two-endpoint date-range picker (departure / return) sharing a single
 * calendar surface — used where a trip's outbound and return dates are
 * naturally picked together.
 */
export function DateRangePicker({
  from,
  to,
  onChange,
  placeholder = "Select dates",
  minDate,
  className,
}: {
  from: string | null | undefined;
  to: string | null | undefined;
  onChange: (range: { from: string | null; to: string | null }) => void;
  placeholder?: string;
  minDate?: Date;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const range = { from: toDate(from), to: toDate(to) };
  const hasRange = range.from || range.to;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn("w-full justify-between font-normal", !hasRange && "text-muted-foreground", className)}
        >
          <span className="flex items-center gap-2 truncate">
            <CalendarIcon className="h-3.5 w-3.5 shrink-0" />
            {range.from && range.to
              ? `${format(range.from, "MMM d")} — ${format(range.to, "MMM d, yyyy")}`
              : range.from
                ? `${format(range.from, "MMM d, yyyy")} — ...`
                : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          selected={range}
          defaultMonth={range.from}
          onSelect={(next) => {
            onChange({ from: toIso(next?.from), to: toIso(next?.to) });
            if (next?.from && next?.to) setOpen(false);
          }}
          disabled={(date) => (minDate ? date < minDate : false)}
          numberOfMonths={2}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
