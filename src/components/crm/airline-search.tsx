"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, ChevronsUpDown, Building2, Loader2 } from "lucide-react";
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
import { searchAirlines, type AirlineOption } from "@/server/queries/reference-data";

export function AirlineSearchField({
  value,
  onChange,
  placeholder = "Search airline...",
  portalContainer,
  ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: AirlineOption | null;
  onChange: (airline: AirlineOption | null) => void;
  placeholder?: string;
  /** Portal target — see DatePicker's identical prop for why customer-facing
   * pages need this. Omit for CRM usage (unaffected). */
  portalContainer?: HTMLElement | null;
  /** Standalone-usage fallback accessible name — see AirportSearchField's
   * identical props for the full explanation. Ignored whenever
   * `aria-labelledby` is also given. */
  ariaLabel?: string;
  /** Id of an existing, already-rendered visible label to derive the
   * accessible name from — the preferred mechanism when a caller already
   * renders one (see flight-segment-editor.tsx's FieldSlot). */
  "aria-labelledby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<AirlineOption[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      startTransition(async () => {
        const results = await searchAirlines(query);
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
            <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {value ? (
              <span className="truncate">
                <span className="font-semibold">{value.iata ?? value.icao}</span>{" "}
                <span className="text-muted-foreground">— {value.name}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start" container={portalContainer}>
        <Command shouldFilter={false}>
          <CommandInput placeholder="IATA/ICAO code, airline name..." value={query} onValueChange={setQuery} />
          <CommandList>
            {isPending && (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {!isPending && options.length === 0 && <CommandEmpty>No airlines found.</CommandEmpty>}
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
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span className="font-semibold">{a.iata ?? a.icao}</span> — {a.name}
                    </p>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
