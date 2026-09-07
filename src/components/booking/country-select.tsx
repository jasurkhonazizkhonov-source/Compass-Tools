"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
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
import { PHONE_COUNTRIES } from "@/lib/phone";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

// Full real ISO country list (via libphonenumber-js's getCountries(), the
// same source PhoneInput/AirportSearchField already use) — no hand-picked
// subset. `value`/`onChange` operate on the country's display NAME (e.g.
// "United States"), matching Booking.billingCountry's existing free-text
// shape, so this is a drop-in replacement for the bare <Input> it replaces
// with no backend/schema change. Unlike PhoneInput's countryDisplayLabel,
// this must NOT append a calling code — it's a mailing-address country,
// not a phone country, and the stored value is this exact label.
function countryName(code: (typeof PHONE_COUNTRIES)[number]): string {
  return regionNames.of(code) ?? code;
}
const SORTED_COUNTRIES = [...PHONE_COUNTRIES].sort((a, b) => countryName(a).localeCompare(countryName(b)));

export function CountrySelect({
  value,
  onChange,
  placeholder = "Select country",
}: {
  value: string;
  onChange: (countryName: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value || placeholder}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search country..." />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {SORTED_COUNTRIES.map((code) => {
                const name = countryName(code);
                return (
                  <CommandItem
                    key={code}
                    value={name}
                    onSelect={() => {
                      onChange(name);
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("h-4 w-4", value === name ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{name}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export const DEFAULT_COUNTRY_NAME = "United States";
