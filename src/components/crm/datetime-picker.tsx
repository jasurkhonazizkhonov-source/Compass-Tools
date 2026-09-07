"use client";

import { useState } from "react";
import { format, parseISO, isValid, setHours, setMinutes } from "date-fns";
import { CalendarIcon, X, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

function toDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = parseISO(value);
  return isValid(d) ? d : undefined;
}

/** Combined date + time picker for due dates that need a specific time, not just a day. */
export function DateTimePicker({
  value,
  onChange,
  placeholder = "Select due date",
  minDate,
  className,
}: {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  placeholder?: string;
  minDate?: Date;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = toDate(value);
  const timeValue = selected ? format(selected, "HH:mm") : "09:00";

  function commit(date: Date | undefined, time: string) {
    if (!date) {
      onChange(null);
      return;
    }
    const [h, m] = time.split(":").map(Number);
    const next = setMinutes(setHours(date, h || 0), m || 0);
    onChange(next.toISOString());
  }

  return (
    <div className={cn("flex gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn("flex-1 justify-between font-normal", !selected && "text-muted-foreground")}
          >
            <span className="flex items-center gap-2 truncate">
              <CalendarIcon className="h-3.5 w-3.5 shrink-0" />
              {selected ? format(selected, "MMM d, yyyy") : placeholder}
            </span>
            {selected && (
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
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected}
            onSelect={(date) => {
              commit(date, timeValue);
              setOpen(false);
            }}
            disabled={(date) => (minDate ? date < minDate : false)}
            autoFocus
          />
        </PopoverContent>
      </Popover>
      <div className="relative w-[7.5rem] shrink-0">
        <Clock className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none z-10" />
        <Input
          type="time"
          value={timeValue}
          disabled={!selected}
          onChange={(e) => commit(selected, e.target.value)}
          className="pl-8"
        />
      </div>
    </div>
  );
}
