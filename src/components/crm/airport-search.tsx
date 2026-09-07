"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, ChevronsUpDown, Plane, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { searchAirports, type AirportOption } from "@/server/queries/reference-data";

export function AirportSearchField({
  value,
  onChange,
  placeholder = "Search airport or city...",
  disabled,
  ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  value: AirportOption | null;
  onChange: (airport: AirportOption | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Standalone-usage fallback accessible name, e.g. for a call site with
   * no wrapping <label> at all. Ignored (per standard ARIA precedence)
   * whenever `aria-labelledby` is also given. */
  ariaLabel?: string;
  /** Id of an existing, already-rendered <label>-like element to derive
   * the accessible name from — the preferred mechanism when a caller
   * already renders a visible label next to this field (see
   * flight-segment-editor.tsx's FieldSlot), since this is a custom
   * combobox button, not a native input a plain `<label for>` can target
   * implicitly. Without one of these two, two of these fields side by
   * side ("From"/"To") would both expose the identical accessible name
   * "Search airport or city..." until a value is picked. Omitting both
   * preserves every pre-existing call site's behavior unchanged. */
  "aria-labelledby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<AirportOption[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      startTransition(async () => {
        const results = await searchAirports(query);
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
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="flex items-center gap-2 truncate">
            <Plane className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {value ? (
              <span className="truncate">
                <span className="font-semibold">{value.iata}</span>{" "}
                <span className="text-muted-foreground">— {value.city || value.name}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="IATA code, city, airport, country..." value={query} onValueChange={setQuery} />
          <CommandList>
            {isPending && (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {!isPending && options.length === 0 && <CommandEmpty>No airports found.</CommandEmpty>}
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
                      <span className="font-semibold">{a.iata}</span> — {a.city || a.name}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {a.name}, {a.country}
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
