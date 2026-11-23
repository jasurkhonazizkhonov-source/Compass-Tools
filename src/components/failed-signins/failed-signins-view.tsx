"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { EmptyState } from "@/components/crm/empty-state";
import { DateRangeFilterFields } from "@/components/commissions/range-date-fields";
import { deleteFailedSignInEvents } from "@/server/actions/failed-signins";
import { FAILED_SIGNIN_REASONS, FAILED_SIGNIN_METHODS, reasonLabel, methodLabel } from "@/lib/failed-signin";
import { businessDayKey, formatBusinessTime, formatDayKey } from "@/lib/business-time";
import type { FailedSignInPage, FailedSignInFilters, FailedSignInRow } from "@/server/queries/failed-signins";

type Row = Omit<FailedSignInRow, "occurredAt"> & { occurredAt: string };
type Data = Omit<FailedSignInPage, "rows"> & { rows: Row[] };

const place = (r: Row) => [r.city, r.region, r.country].filter(Boolean).join(", ") || "Location unavailable";
const identity = (r: Row) => ({
  name: r.verifiedFullName ?? "Unavailable",
  email: r.verifiedEmail ?? r.attemptedEmail ?? "Unavailable",
  verified: !!r.verifiedEmail,
});

/**
 * The failed sign-in log: grouped by business-zone day (newest first, each day expandable), one row per attempt, server-paginated and filtered through the URL.
 * Selection is explicit and per page: "select all" selects only the rows shown, and deleting sends exactly those ids. The server re-checks the Administrator
 * role on every action; nothing here is a security control.
 */
export function FailedSignInsView({ data, filters }: { data: Data; filters: FailedSignInFilters }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [inspected, setInspected] = useState<Row | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of data.rows) {
      const key = businessDayKey(new Date(r.occurredAt));
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()];
  }, [data.rows]);

  const pageIds = data.rows.map((r) => r.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someSelected = pageIds.some((id) => selected.has(id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePage = () => setSelected(allSelected ? new Set() : new Set(pageIds)); // ONLY this page's rows: never other pages

  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Filter failed sign-ins">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
          Search
          <Input name="q" defaultValue={filters.q ?? ""} placeholder="Name, email, IP address or event ID" maxLength={120} />
        </label>
        {/* Keyed by the applied filter, so Clear / a new search resets the pickers (they hold their own state). */}
        <DateRangeFilterFields key={`${filters.from ?? ""}|${filters.to ?? ""}`} initialFrom={filters.from ?? ""} initialTo={filters.to ?? ""} testIdPrefix="failed-signins-date" />
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Reason
          <select name="reason" defaultValue={filters.reason ?? ""} className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground dark:bg-input/30">
            <option value="">All reasons</option>
            {Object.entries(FAILED_SIGNIN_REASONS).map(([code, m]) => (
              <option key={code} value={code}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Method
          <select name="method" defaultValue={filters.method ?? ""} className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground dark:bg-input/30">
            <option value="">All methods</option>
            {Object.entries(FAILED_SIGNIN_METHODS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          IP address
          <Input name="ip" defaultValue={filters.ip ?? ""} placeholder="Exact address" maxLength={45} />
        </label>
        <Button type="submit" size="sm">
          Apply
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => router.push("/failed-signins")}>
          Clear
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-3 text-sm" aria-live="polite">
        <label className="flex items-center gap-2">
          <Checkbox checked={allSelected ? true : someSelected ? "indeterminate" : false} onCheckedChange={togglePage} aria-label="Select all records on this page" disabled={pageIds.length === 0} />
          <span>Select all on this page</span>
        </label>
        <span className="text-muted-foreground" data-testid="selected-count">
          {selected.size} selected
        </span>
        <Button type="button" size="sm" variant="destructive" disabled={selected.size === 0} onClick={() => setConfirming([...selected])}>
          Delete selected
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">{data.total.toLocaleString("en-US")} matching attempts</span>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={ChevronDown} title="No failed sign-ins" description="Nothing matches these filters. Unsuccessful sign-in attempts appear here as they happen." />
      ) : (
        groups.map(([day, rows], i) => (
          <details key={day} open={i === 0} className="rounded-lg border bg-card" data-testid="day-group">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-semibold">
              <ChevronDown className="h-4 w-4" aria-hidden />
              {formatDayKey(day)} <span className="font-normal text-muted-foreground">- {(data.dayTotals[day] ?? rows.length).toLocaleString("en-US")} failed attempt{(data.dayTotals[day] ?? rows.length) === 1 ? "" : "s"}</span>
            </summary>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Full name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>IP address</TableHead>
                    <TableHead>Location (approximate)</TableHead>
                    <TableHead>Exact time</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Method</TableHead>
                    {/* Sticky to the right edge: on a phone the table scrolls sideways and Inspect / Delete would otherwise sit about 900px away. Same technique as the Users table's sticky Name column. */}
                    <TableHead className="sticky right-0 z-10 bg-card text-right shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.25)]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const who = identity(r);
                    const notes = data.indicators[r.id] ?? [];
                    return (
                      <TableRow key={r.id} data-testid="failed-signin-row" className="group">
                        <TableCell>
                          <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} aria-label={`Select attempt ${r.id}`} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{who.name}</TableCell>
                        <TableCell className="max-w-[16rem] truncate">
                          {who.email}
                          {who.email !== "Unavailable" && <span className="ml-1 text-[10px] uppercase text-muted-foreground">{who.verified ? "verified" : "unverified"}</span>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">{r.ipAddress ?? "Unavailable"}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{place(r)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs tabular-nums" title={new Date(r.occurredAt).toISOString()}>
                          {formatBusinessTime(new Date(r.occurredAt))}
                        </TableCell>
                        <TableCell className="text-xs">
                          {reasonLabel(r.reasonCode)}
                          {r.repeatCount > 1 && <span className="ml-1 font-semibold">x{r.repeatCount}</span>}
                          {notes.map((n) => (
                            <p key={n} className="mt-0.5 text-[11px] text-warning-foreground" data-testid="indicator">
                              {n}
                            </p>
                          ))}
                        </TableCell>
                        <TableCell className="text-xs">{methodLabel(r.method)}</TableCell>
                        <TableCell className="sticky right-0 z-10 bg-card text-right whitespace-nowrap shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.25)] group-hover:bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))]">
                          <div className="flex items-center justify-end gap-1">
                            <Button type="button" variant="ghost" size="sm" onClick={() => setInspected(r)} aria-label={`Inspect attempt ${r.id}`}>
                              Inspect
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming([r.id])} aria-label={`Delete attempt ${r.id}`}>
                              Delete
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </details>
        ))
      )}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={`Delete ${confirming?.length ?? 0} failed sign-in record${confirming?.length === 1 ? "" : "s"}?`}
        description="These records are removed permanently, including the names, emails and addresses in them. Only the records you selected are deleted. The deletion is recorded in the audit log without any of that information."
        confirmLabel="Delete records"
        onConfirm={async () => {
          const ids = confirming ?? [];
          const result = await deleteFailedSignInEvents(ids);
          if (!result.ok) return { error: result.error };
          toast.success(`${result.deleted} record${result.deleted === 1 ? "" : "s"} deleted`);
          setSelected(new Set());
          router.refresh();
        }}
      />

      <Dialog open={inspected !== null} onOpenChange={(o) => !o && setInspected(null)}>
        <DialogContent className="sm:max-w-lg">
          {inspected && (
            <>
              <DialogHeader>
                <DialogTitle>Failed sign-in attempt</DialogTitle>
                <DialogDescription>{FAILED_SIGNIN_REASONS[inspected.reasonCode as keyof typeof FAILED_SIGNIN_REASONS]?.description ?? "Unsuccessful sign-in attempt."}</DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1.5 text-sm" data-testid="event-details">
                <dt className="text-muted-foreground">Event ID</dt><dd className="font-mono text-xs">{inspected.id}</dd>
                <dt className="text-muted-foreground">Time (UTC)</dt><dd>{new Date(inspected.occurredAt).toISOString().replace("T", " ").slice(0, 19)}</dd>
                <dt className="text-muted-foreground">Time (CRM zone)</dt><dd>{formatDayKey(businessDayKey(new Date(inspected.occurredAt)))} {formatBusinessTime(new Date(inspected.occurredAt))}</dd>
                <dt className="text-muted-foreground">Method</dt><dd>{methodLabel(inspected.method)}</dd>
                <dt className="text-muted-foreground">Reason</dt><dd>{reasonLabel(inspected.reasonCode)}{inspected.repeatCount > 1 ? ` (${inspected.repeatCount} attempts)` : ""}</dd>
                <dt className="text-muted-foreground">Verified name</dt><dd>{inspected.verifiedFullName ?? "Unavailable"}</dd>
                <dt className="text-muted-foreground">Verified email</dt><dd>{inspected.verifiedEmail ?? "Unavailable"}</dd>
                <dt className="text-muted-foreground">Attempted email (unverified)</dt><dd>{inspected.attemptedEmail ?? "Unavailable"}</dd>
                <dt className="text-muted-foreground">IP address</dt><dd className="font-mono text-xs">{inspected.ipAddress ?? "Unavailable"}</dd>
                <dt className="text-muted-foreground">Approximate location</dt><dd>{place(inspected)}</dd>
                <dt className="text-muted-foreground">Location source</dt><dd>{inspected.geoSource ?? "Unavailable"}</dd>
              </dl>
              <p className="text-xs text-muted-foreground">An IP address does not identify a person, and the location is only an estimate of where the network connection appears to be.</p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
