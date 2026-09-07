"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { PHONE_COUNTRIES, countryDisplayLabel, getCountryCallingCode, normalizePhoneNumber, type CountryCode } from "@/lib/phone";
import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * International phone input — a searchable country selector (the full
 * libphonenumber-js country list, not a hand-picked subset) plus a
 * national-number field. The two are kept as separate controlled values
 * (never a single freeform string) so the selected country is always
 * explicit and normalizePhoneNumber() always has what it needs.
 */
export function PhoneInput({
  country,
  onCountryChange,
  nationalNumber,
  onNationalNumberChange,
  onBlur,
  placeholder = "Phone number",
}: {
  country: CountryCode;
  onCountryChange: (country: CountryCode) => void;
  nationalNumber: string;
  onNationalNumberChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" role="combobox" aria-expanded={open} className="w-[110px] shrink-0 justify-between font-normal px-2.5">
            <span className="truncate">+{getCountryCallingCode(country)}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[280px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search country..." />
            <CommandList>
              <CommandEmpty>No country found.</CommandEmpty>
              <CommandGroup>
                {PHONE_COUNTRIES.map((c) => (
                  <CommandItem
                    key={c}
                    value={countryDisplayLabel(c)}
                    onSelect={() => {
                      onCountryChange(c);
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("h-4 w-4", country === c ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{countryDisplayLabel(c)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Input
        value={nationalNumber}
        onChange={(e) => onNationalNumberChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        type="tel"
        autoComplete="tel-national"
        className="flex-1"
      />
    </div>
  );
}

/** Default country for a fresh phone field — United States, per this app's
 * primary market. Callers editing an existing E.164 number should instead
 * derive the country from that number (see parsePhoneNumberFromString in
 * @/lib/phone) rather than defaulting. */
export const DEFAULT_PHONE_COUNTRY: CountryCode = "US";

/**
 * Single-value wrapper around PhoneInput for callers that only have a plain
 * `value`/`onChange` pair to work with (e.g. InlineEditField's `editor`
 * prop, or a simple "add a phone number" form field) rather than separately
 * managed country/national state. Country + national number are derived
 * from `value` once on mount (via parsePhoneNumberFromString) and kept as
 * local state thereafter so typing doesn't get re-parsed on every
 * keystroke; `onChange` is called with the normalized E.164 form whenever
 * it parses to a valid number, or the raw national digits otherwise so the
 * caller always has *something* to save/validate against.
 */
export function PhoneValueInput({
  value,
  onChange,
  onBlur,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  const parsed = value ? parsePhoneNumberFromString(value) : undefined;
  const [country, setCountry] = useState<CountryCode>((parsed?.country as CountryCode) ?? DEFAULT_PHONE_COUNTRY);
  const [national, setNational] = useState(parsed ? parsed.formatNational() : value);

  function update(nextCountry: CountryCode, nextNational: string) {
    setCountry(nextCountry);
    setNational(nextNational);
    onChange(normalizePhoneNumber(nextNational, nextCountry) ?? nextNational);
  }

  return (
    <PhoneInput
      country={country}
      onCountryChange={(c) => update(c, national)}
      nationalNumber={national}
      onNationalNumberChange={(n) => update(country, n)}
      onBlur={onBlur}
      placeholder={placeholder}
    />
  );
}
