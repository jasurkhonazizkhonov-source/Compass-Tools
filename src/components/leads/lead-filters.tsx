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
import { LEAD_STATUS_META, LEAD_STATUS_ORDER, leadSourceLabel } from "@/lib/status-meta";
import type { LeadSource } from "@/generated/prisma/client";

type Agent = { id: string; fullName: string };

const CABIN_CLASSES = ["ECONOMY", "PREMIUM_ECONOMY", "BUSINESS", "FIRST"];
const TRIP_TYPES = ["ONE_WAY", "ROUND_TRIP", "MULTI_CITY"];
const SOURCES = ["WEBSITE", "PHONE", "EMAIL", "WHATSAPP", "FACEBOOK", "INSTAGRAM", "REFERRAL", "OTHER"];

export function LeadFilters({ agents }: { agents: Agent[] }) {
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

  const activeFilterCount = ["status", "agent", "cabin", "trip", "source"].filter((k) => searchParams.get(k)).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search name, phone, email, route..."
          className="pl-8 h-9"
        />
      </div>

      <Select value={searchParams.get("status") ?? "all"} onValueChange={(v) => setParam("status", v === "all" ? null : v)}>
        <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Status" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          {LEAD_STATUS_ORDER.map((s) => (
            <SelectItem key={s} value={s}>{LEAD_STATUS_META[s].label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={searchParams.get("agent") ?? "all"} onValueChange={(v) => setParam("agent", v === "all" ? null : v)}>
        <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Agent" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All agents</SelectItem>
          {agents.map((a) => (
            <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>
          ))}
          {/* Pass 10 — a distinct sentinel value ("unassigned"), never
           * ambiguous with the empty-string "All agents" default, per the
           * task's own explicit URL-state requirement. */}
          <SelectItem value="unassigned">Unassigned</SelectItem>
        </SelectContent>
      </Select>

      <Select value={searchParams.get("cabin") ?? "all"} onValueChange={(v) => setParam("cabin", v === "all" ? null : v)}>
        <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Cabin" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All cabins</SelectItem>
          {CABIN_CLASSES.map((c) => (
            <SelectItem key={c} value={c}>{c.replace("_", " ")}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={searchParams.get("trip") ?? "all"} onValueChange={(v) => setParam("trip", v === "all" ? null : v)}>
        <SelectTrigger className="h-9 w-[140px]"><SelectValue placeholder="Trip type" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All trip types</SelectItem>
          {TRIP_TYPES.map((t) => (
            <SelectItem key={t} value={t}>{t.replace("_", " ")}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={searchParams.get("source") ?? "all"} onValueChange={(v) => setParam("source", v === "all" ? null : v)}>
        <SelectTrigger className="h-9 w-[140px]"><SelectValue placeholder="Source" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All sources</SelectItem>
          {SOURCES.map((s) => (
            <SelectItem key={s} value={s}>{leadSourceLabel(s as LeadSource)}</SelectItem>
          ))}
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
