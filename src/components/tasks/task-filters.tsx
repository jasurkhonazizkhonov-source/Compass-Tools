"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PRIORITY_META } from "@/lib/status-meta";
import type { Priority } from "@/generated/prisma/client";

type Agent = { id: string; fullName: string };

const DUE_OPTIONS = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "week", label: "Due this week" },
  { value: "no_date", label: "No due date" },
];

const PRIORITIES: Priority[] = ["LOW", "MEDIUM", "HIGH"];

const SORT_OPTIONS = [
  { value: "due_asc", label: "Due date (soonest)" },
  { value: "due_desc", label: "Due date (latest)" },
  { value: "created_desc", label: "Newest first" },
  { value: "created_asc", label: "Oldest first" },
];

export function TaskFilters({ agents, canScopeByUser }: { agents: Agent[]; canScopeByUser: boolean }) {
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

  const activeFilterCount = ["status", "due", "priority"].filter((k) => searchParams.get(k)).length + (searchParams.get("scope") && searchParams.get("scope") !== "mine" ? 1 : 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search tasks, customers..."
          className="pl-8 h-9"
        />
      </div>

      <Select value={searchParams.get("status") ?? "all"} onValueChange={(v) => setParam("status", v === "all" ? null : v)}>
        <SelectTrigger className="h-9 w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="PENDING">Pending</SelectItem>
          <SelectItem value="COMPLETED">Completed</SelectItem>
        </SelectContent>
      </Select>

      <Select value={searchParams.get("due") ?? "all"} onValueChange={(v) => setParam("due", v === "all" ? null : v)}>
        <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Due" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any due date</SelectItem>
          {DUE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {canScopeByUser && (
        <Select value={searchParams.get("scope") ?? "mine"} onValueChange={(v) => setParam("scope", v === "mine" ? null : v)}>
          <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="My Tasks" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="mine">My Tasks</SelectItem>
            <SelectItem value="all">All Tasks</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select value={searchParams.get("priority") ?? "all"} onValueChange={(v) => setParam("priority", v === "all" ? null : v)}>
        <SelectTrigger className="h-9 w-[130px]"><SelectValue placeholder="Priority" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All priorities</SelectItem>
          {PRIORITIES.map((p) => (
            <SelectItem key={p} value={p}>{PRIORITY_META[p].label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={searchParams.get("sort") ?? "due_asc"} onValueChange={(v) => setParam("sort", v === "due_asc" ? null : v)}>
        <SelectTrigger className="h-9 w-[180px]"><SelectValue placeholder="Sort" /></SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {(activeFilterCount > 0 || q || searchParams.get("sort")) && (
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
    </div>
  );
}
