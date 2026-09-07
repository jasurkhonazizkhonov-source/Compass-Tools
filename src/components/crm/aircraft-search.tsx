"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, ChevronsUpDown, Plane, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { searchAircraft, type AircraftOption } from "@/server/queries/reference-data";

export function AircraftSearchField({
  value,
  onChange,
  placeholder = "Search aircraft...",
  ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: AircraftOption | null;
  onChange: (aircraft: AircraftOption | null) => void;
  placeholder?: string;
  /** Standalone-usage fallback accessible name — see AirportSearchField's
   * identical props for the full explanation. Ignored whenever
   * `aria-labelledby` is also given. */
  ariaLabel?: string;
  /** Id of an existing, already-rendered visible label to derive the
   * accessible name from — the preferred mechanism when a caller already
   * renders one (see flight-segment-editor.tsx). */
  "aria-labelledby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<AircraftOption[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      startTransition(async () => {
        const results = await searchAircraft(query);
        setOptions(results);
      });
    }, 150);
    return () => clearTimeout(handle);
  }, [query, open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabelledBy ? undefined : ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className="w-full justify-between font-normal"
        >
          <span className="flex items-center gap-2 truncate">
            <Plane className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {value ? (
              <span className="truncate">{value.displayName}</span>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="e.g. 787, A380, Boeing..." value={query} onValueChange={setQuery} />
          <CommandList>
            {isPending && (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {!isPending && options.length === 0 && <CommandEmpty>No aircraft found.</CommandEmpty>}
            <CommandGroup>
              {options.map((a) => (
                <CommandItem
                  key={a.id}
                  value={String(a.id)}
                  onSelect={() => {
                    onChange(a);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("h-4 w-4", value?.id === a.id ? "opacity-100" : "opacity-0")} />
                  <span className="text-sm">{a.displayName}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
