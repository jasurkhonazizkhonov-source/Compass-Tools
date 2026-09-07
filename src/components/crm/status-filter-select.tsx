"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Option = { value: string; label: string };

/**
 * Status filter for a paginated list page (Quotes/Bookings, and anywhere
 * else this pattern is reused) — reads/writes the `status` query param.
 * Single-select mode (default) keeps the original plain-dropdown UI.
 * Multi-select mode (`multiple`) renders a checkbox popover instead and
 * stores a comma-separated list of statuses in the same param, so both
 * modes share one URL contract and one component rather than two parallel
 * implementations. Whichever new statuses a caller passes in `options`
 * (e.g. exchange/cancellation statuses added alongside the existing ones)
 * automatically show up here with zero changes to this file — the option
 * list is entirely caller-driven, never hardcoded.
 */
export function StatusFilterSelect({
  paramKey = "status",
  options,
  placeholder = "Status",
  allLabel = "All statuses",
  multiple = false,
}: {
  paramKey?: string;
  options: Option[];
  placeholder?: string;
  /** Label for the "no filter applied" option — e.g. "All agents" when this
   * is reused for a non-status param (see Quotes/Bookings' Agent filter).
   * Defaults to the original "All statuses" wording so every existing
   * status-filter call site is unaffected. */
  allLabel?: string;
  multiple?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function pushParams(params: URLSearchParams) {
    params.delete("page");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  if (!multiple) {
    function handleChange(value: string) {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all") params.delete(paramKey);
      else params.set(paramKey, value);
      pushParams(params);
    }

    return (
      <Select value={searchParams.get(paramKey) ?? "all"} onValueChange={handleChange}>
        <SelectTrigger className="h-9 w-[180px]"><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const selected = new Set((searchParams.get(paramKey) ?? "").split(",").filter(Boolean));

  function toggle(value: string) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    const params = new URLSearchParams(searchParams.toString());
    if (next.size === 0) params.delete(paramKey);
    else params.set(paramKey, [...next].join(","));
    pushParams(params);
  }

  function clearAll() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(paramKey);
    pushParams(params);
  }

  const label =
    selected.size === 0
      ? allLabel
      : selected.size === 1
        ? (options.find((o) => o.value === [...selected][0])?.label ?? placeholder)
        : `${selected.size} statuses`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn("h-9 w-[180px] justify-between font-normal", selected.size > 0 && "border-primary/50 text-foreground")}>
          <span className="truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="flex items-center justify-between text-xs font-normal text-muted-foreground">
          {placeholder}
          {selected.size > 0 && (
            <button type="button" onClick={clearAll} className="text-xs text-primary hover:underline">
              Clear
            </button>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={selected.has(o.value)}
            onCheckedChange={() => toggle(o.value)}
            onSelect={(e) => e.preventDefault()}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
