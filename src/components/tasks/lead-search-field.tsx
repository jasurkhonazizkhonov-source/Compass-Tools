"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, ChevronsUpDown, User, Loader2 } from "lucide-react";
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
import { searchLeadsForTaskLinkAction } from "@/server/actions/tasks";

export type LeadOption = Awaited<ReturnType<typeof searchLeadsForTaskLinkAction>>[number];

export function LeadSearchField({
  value,
  onChange,
  placeholder = "Link to a lead (optional)...",
}: {
  value: LeadOption | null;
  onChange: (lead: LeadOption | null) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<LeadOption[]>([]);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      startTransition(async () => {
        const results = await searchLeadsForTaskLinkAction(query);
        setOptions(results);
      });
    }, 150);
    return () => clearTimeout(handle);
  }, [query, open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
          <span className="flex items-center gap-2 truncate">
            <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {value ? (
              <span className="truncate">
                {value.contact.firstName} {value.contact.lastName}
                {value.departureAirport && value.arrivalAirport && (
                  <span className="text-muted-foreground"> — {value.departureAirport.iata} → {value.arrivalAirport.iata}</span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Customer name..." value={query} onValueChange={setQuery} />
          <CommandList>
            {isPending && (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {!isPending && options.length === 0 && <CommandEmpty>No leads found.</CommandEmpty>}
            <CommandGroup>
              {value && (
                <CommandItem value="__clear__" onSelect={() => { onChange(null); setOpen(false); }}>
                  <span className="text-muted-foreground">Clear selection</span>
                </CommandItem>
              )}
              {options.map((lead) => (
                <CommandItem
                  key={lead.id}
                  value={lead.id}
                  onSelect={() => {
                    onChange(lead);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("h-4 w-4", value?.id === lead.id ? "opacity-100" : "opacity-0")} />
                  <div className="min-w-0">
                    <p className="text-sm">
                      {lead.contact.firstName} {lead.contact.lastName}
                    </p>
                    {lead.departureAirport && lead.arrivalAirport && (
                      <p className="text-xs text-muted-foreground">{lead.departureAirport.iata} → {lead.arrivalAirport.iata}</p>
                    )}
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
