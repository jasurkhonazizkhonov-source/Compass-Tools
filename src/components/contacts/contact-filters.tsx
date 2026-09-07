"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Agent = { id: string; fullName: string };

/**
 * Contacts filter bar — same design/interaction pattern as LeadFilters
 * (src/components/leads/lead-filters.tsx): a search box plus a row of
 * Selects, each reading/writing its own query param, reset to page 1 on
 * every change. `agents` is only ever non-empty when the caller has already
 * gated it server-side by canViewAllRecords (see contacts/page.tsx) — a
 * restricted viewer simply never receives an agent list, so this component
 * doesn't need its own permission check to decide whether to render the
 * Agent select.
 */
export function ContactFilters({ agents }: { agents: Agent[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(searchParams.get("q") ?? "");

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      params.delete("page");
      startTransition(() => router.push(`${pathname}?${params.toString()}`));
    },
    [router, pathname, searchParams]
  );

  function handleSearchChange(value: string) {
    setQ(value);
    setParam("q", value || null);
  }

  const filterKeys = agents.length > 0 ? ["agent", "hasEmail", "hasPhone"] : ["hasEmail", "hasPhone"];
  const activeFilterCount = filterKeys.filter((k) => searchParams.get(k)).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-72">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search name, phone, email..."
          className="pl-8 h-9"
        />
      </div>

      {agents.length > 0 && (
        <Select value={searchParams.get("agent") ?? "all"} onValueChange={(v) => setParam("agent", v === "all" ? null : v)}>
          <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Agent" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>
            ))}
            {/* Pass 10 — a distinct sentinel value ("unassigned"), never
             * ambiguous with the empty-string "All agents" default. */}
            <SelectItem value="unassigned">Unassigned</SelectItem>
          </SelectContent>
        </Select>
      )}

      <Select value={searchParams.get("hasEmail") ?? "all"} onValueChange={(v) => setParam("hasEmail", v === "all" ? null : v)}>
        <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Email" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any email status</SelectItem>
          <SelectItem value="true">Has email</SelectItem>
          <SelectItem value="false">No email</SelectItem>
        </SelectContent>
      </Select>

      <Select value={searchParams.get("hasPhone") ?? "all"} onValueChange={(v) => setParam("hasPhone", v === "all" ? null : v)}>
        <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Phone" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any phone status</SelectItem>
          <SelectItem value="true">Has phone</SelectItem>
          <SelectItem value="false">No phone</SelectItem>
        </SelectContent>
      </Select>

      {(activeFilterCount > 0 || q) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 gap-1 text-muted-foreground"
          onClick={() => {
            setQ("");
            startTransition(() => router.push(pathname));
          }}
        >
          <X className="h-3.5 w-3.5" /> Clear
        </Button>
      )}

      {activeFilterCount > 0 && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <SlidersHorizontal className="h-3 w-3" /> {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}
