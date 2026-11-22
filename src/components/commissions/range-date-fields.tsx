"use client";

import { useEffect, useId, useRef, useState } from "react";
import { format, isValid, parseISO } from "date-fns";
import type { Matcher } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The From / To fields of the custom range form on the Commissions and Salesboard pages, drawn as a modern calendar popover instead of the
 * browser's native date input (ReportRangeControls opts in with `modernCalendar`). Both reports therefore share one date-range control. Each popover
 * highlights the whole chosen range (the first and last day strongly, the days between softly), so the span being reported is visible at a glance.
 *
 * Nothing about the data changes: the form is still a plain GET form, and this component still submits two fields named `from` and
 * `to` holding `yyyy-MM-dd` text, which the server resolves with the same range resolver as before (a reversed or missing range is
 * still answered with the warning and the current pay period). Dates are picked and shown as LOCAL calendar days and serialised
 * with the same local `yyyy-MM-dd` formatting the app's shared DatePicker uses, so no timezone conversion can shift a day.
 */
function toDate(value: string): Date | undefined {
  if (!value) return undefined;
  const d = parseISO(value);
  return isValid(d) ? d : undefined;
}

function DateField({
  label,
  name,
  value,
  onChange,
  rangeFrom,
  rangeTo,
  testId,
  clearable = false,
  disabledDays,
}: {
  label: string;
  name: "from" | "to";
  value: string;
  onChange: (next: string) => void;
  /** The other bound(s), only to draw the highlighted span in this calendar; they never change what this field submits. */
  rangeFrom?: Date;
  rangeTo?: Date;
  /** Defaults to the Commissions / Salesboard id. */
  testId?: string;
  /** An optional field (a filter): offers "Clear date" so it can go back to empty. The Commissions range is required, so it is off there. */
  clearable?: boolean;
  /** Days that cannot be chosen (react-day-picker matchers), used to make a reversed From / To range impossible to pick. */
  disabledDays?: Matcher;
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const selected = toDate(value);
  const spanOk = !!rangeFrom && !!rangeTo && rangeFrom.getTime() <= rangeTo.getTime();
  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            aria-labelledby={labelId}
            data-testid={testId ?? `commission-date-${name}`}
            className={cn("h-8 w-[10.5rem] justify-start gap-2 px-2.5 font-normal tabular-nums", !selected && "text-muted-foreground")}
          >
            <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{selected ? format(selected, "MMM d, yyyy") : "Select date"}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto rounded-xl p-0 shadow-lg" align="start">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected}
            onSelect={(date) => {
              if (!date) return; // clicking the selected day again must not blank the field
              onChange(format(date, "yyyy-MM-dd"));
              setOpen(false);
            }}
            autoFocus
            disabled={disabledDays}
            modifiers={spanOk ? { inRange: { from: rangeFrom!, to: rangeTo! } } : undefined}
            modifiersClassNames={{ inRange: "bg-primary/10 data-[selected=true]:bg-transparent" }}
            buttonVariant="outline"
            className="p-3 [--cell-radius:var(--radius-lg)] [--cell-size:--spacing(9)]"
            classNames={{
              month: "flex w-full flex-col gap-3",
              month_caption: "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size) text-sm font-semibold",
              caption_label: "text-sm font-semibold select-none",
              weekday: "flex-1 text-center text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground select-none",
              week: "mt-1 flex w-full",
              today: "rounded-(--cell-radius) font-semibold text-primary ring-1 ring-inset ring-primary/60 data-[selected=true]:text-primary-foreground data-[selected=true]:ring-0",
              outside: "text-muted-foreground/60 aria-selected:text-muted-foreground",
            }}
            components={{
              DayButton: (props) => (
                <CalendarDayButton
                  {...props}
                  className="rounded-(--cell-radius) text-sm hover:bg-primary/10 hover:text-foreground data-[selected-single=true]:font-semibold data-[selected-single=true]:shadow-sm data-[selected-single=true]:hover:bg-primary data-[selected-single=true]:hover:text-primary-foreground"
                />
              ),
            }}
          />
          {clearable && selected && (
            <div className="border-t p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                Clear date
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {/* the value the server receives - the same field name and yyyy-MM-dd text the native input submitted */}
      <input type="hidden" name={name} value={value} />
    </div>
  );
}

/**
 * The OPTIONAL From / To filter pair of an administration list (the failed sign-in log), using the same calendar as the reports above. Either date may be left empty (an open-ended
 * filter), and each submits `yyyy-MM-dd` text under the names `from` and `to` exactly as the native inputs did, so the query, the pagination links and the day-range
 * conversion on the server (business-zone calendar days) are untouched. A reversed range cannot be picked (days after To are disabled in From, days before From in To), and a
 * hand-built one is stopped at submit with a message.
 */
export function DateRangeFilterFields({ initialFrom, initialTo, testIdPrefix = "date-range" }: { initialFrom: string; initialTo: string; testIdPrefix?: string }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [error, setError] = useState<string | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const form = wrapper.current?.closest("form");
    if (!form) return;
    const onSubmit = (e: Event) => {
      if (from && to && from > to) {
        // yyyy-MM-dd text compares correctly as text
        e.preventDefault();
        setError("The From date must be on or before the To date.");
      }
    };
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [from, to]);

  const fromDate = toDate(from);
  const toDay = toDate(to);
  return (
    <div ref={wrapper} className="flex flex-wrap items-end gap-2">
      <DateField
        label="From"
        name="from"
        value={from}
        rangeFrom={fromDate}
        rangeTo={toDay}
        testId={`${testIdPrefix}-from`}
        clearable
        disabledDays={toDay ? { after: toDay } : undefined}
        onChange={(v) => {
          setFrom(v);
          setError(null);
        }}
      />
      <DateField
        label="To"
        name="to"
        value={to}
        rangeFrom={fromDate}
        rangeTo={toDay}
        testId={`${testIdPrefix}-to`}
        clearable
        disabledDays={fromDate ? { before: fromDate } : undefined}
        onChange={(v) => {
          setTo(v);
          setError(null);
        }}
      />
      {error && (
        <p role="alert" className="basis-full text-xs text-destructive" data-testid={`${testIdPrefix}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function CommissionRangeDateFields({ initialFrom, initialTo }: { initialFrom: string; initialTo: string }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [error, setError] = useState<string | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  // The native inputs were `required`; hidden inputs cannot be, so the same rule is applied here before the form is submitted.
  useEffect(() => {
    const form = wrapper.current?.closest("form");
    if (!form) return;
    const onSubmit = (e: Event) => {
      if (!from || !to) {
        e.preventDefault();
        setError("Choose both a From and a To date.");
      }
    };
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [from, to]);

  return (
    <div ref={wrapper} className="flex flex-wrap items-end gap-2">
      <DateField
        label="From"
        name="from"
        value={from}
        rangeFrom={toDate(from)}
        rangeTo={toDate(to)}
        onChange={(v) => {
          setFrom(v);
          setError(null);
        }}
      />
      <DateField
        label="To"
        name="to"
        value={to}
        rangeFrom={toDate(from)}
        rangeTo={toDate(to)}
        onChange={(v) => {
          setTo(v);
          setError(null);
        }}
      />
      {error && (
        <p role="alert" className="basis-full text-xs text-destructive" data-testid="commission-date-error">
          {error}
        </p>
      )}
    </div>
  );
}
