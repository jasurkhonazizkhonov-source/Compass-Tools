"use client";

import { useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { Trash2, XCircle, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { EmptyState } from "@/components/crm/empty-state";
import { Users } from "lucide-react";
import { deleteSubscriber, deleteSubscribers, deleteSubscribersMatchingFilter, getSubscriberCountForFilter } from "@/server/actions/subscribers";
import { BulkSubscriberDialog } from "@/components/subscriptions/bulk-subscriber-dialog";
import type { SubscriberStatus } from "@/generated/prisma/client";

type Subscriber = {
  id: string;
  email: string;
  status: "SUBSCRIBED" | "UNSUBSCRIBED";
  source: string | null;
  subscribedAt: Date;
};

/**
 * Subscriber list — select/delete/bulk-delete (Parts 1-3) plus the status
 * filter (Part 19) and the entry point for Bulk Subscribers (Part 4).
 *
 * Pass 7 §17/§18/§24/§28/§29 — `subscribers` is one server-paginated page
 * (≤25 rows), not the whole company's list; the status filter is a real
 * `?status=` URL param (subscriptions/page.tsx does the actual filtering
 * query-side).
 *
 * Pass 8 §2 — adds the second bulk-selection mode §29 describes: alongside
 * "select all on this page" (Option A, unchanged), a "select all N
 * matching this filter" option (Option B) that logically covers the WHOLE
 * filtered result set without ever fetching/holding every matching row in
 * the browser. Modeled as two independent pieces of state:
 *   - `selectAllMatching: boolean` — true once the user picks the
 *     cross-page option; the browser never learns the individual ids of
 *     rows beyond the current page, only that "everything matching the
 *     current filter, minus `excludedIds`" is selected.
 *   - `excludedIds: Set<string>` — ids the user has explicitly unchecked
 *     since turning `selectAllMatching` on (only ever grows the exclusion
 *     set / shrinks the delete target, never the reverse).
 * Both this component's own `useState` naturally persists across a
 * client-side page navigation (the component itself doesn't unmount when
 * only `subscribers`/`page` change) and is just as naturally torn down if
 * the user navigates away from /subscriptions entirely — no explicit
 * "reset on leave" logic needed, and nothing is written to storage.
 * Changing the status filter always resets both pieces of state (§2's
 * "never accidentally apply the old selection to a different filtered
 * dataset").
 *
 * The actual bulk delete for `selectAllMatching` goes through
 * deleteSubscribersMatchingFilter — a dedicated server action that
 * re-derives the target rows from `status` + the caller's own companyId,
 * never trusting a client-supplied id list for "the whole matching set"
 * (see that action's own doc comment).
 */
export function SubscriberList({
  subscribers,
  counts,
  statusParam,
  status,
  filteredTotal,
}: {
  subscribers: Subscriber[];
  counts: { total: number; subscribed: number; unsubscribed: number };
  /** The resolved `?status=` value from the URL ("all" | "active" |
   * "unsubscribed") — read server-side and passed down so this component
   * never has to re-derive it from useSearchParams itself. */
  statusParam: string;
  /** The same filter, already resolved to the Prisma enum shape
   * getSubscribers itself expects — passed down so the bulk-delete-all
   * action gets sent the exact same filter the list itself was queried
   * with, never a second, possibly-drifted re-derivation of it. */
  status?: SubscriberStatus;
  /** The TRUE count of subscribers matching the current filter, from the
   * server's own count() (Pass 7's getSubscribers already computes this) —
   * never the length of the one page of rows actually in the browser. This
   * is the number "Select all N matching this filter" advertises and the
   * number deleteSubscribersMatchingFilter is expected to (mostly) affect. */
  filteredTotal: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pageSelected, setPageSelected] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [removeOneId, setRemoveOneId] = useState<string | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkAddOpen, setBulkAddOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  // Pass 9 §8 — refreshed right before the confirmation dialog opens for a
  // "select all matching" delete, so the count the user actually confirms
  // reflects current server truth rather than filteredTotal (a snapshot
  // from whenever this page was last rendered — another user/process may
  // have changed the matching set since). Never used by the delete itself,
  // which always re-evaluates its own WHERE clause live regardless.
  const [liveMatchingTotal, setLiveMatchingTotal] = useState<number | null>(null);
  const [isRefreshingCount, setIsRefreshingCount] = useState(false);

  const matchingTotal = liveMatchingTotal ?? filteredTotal;
  const selectedCount = selectAllMatching ? Math.max(0, matchingTotal - excludedIds.size) : pageSelected.size;
  const allOnPageSelected = subscribers.length > 0 && subscribers.every((s) => (selectAllMatching ? !excludedIds.has(s.id) : pageSelected.has(s.id)));
  const someOnPageSelected = subscribers.some((s) => (selectAllMatching ? !excludedIds.has(s.id) : pageSelected.has(s.id))) && !allOnPageSelected;
  // Only offer "select all matching" once there's actually more beyond the
  // current page to select — a one-page result already IS fully selected
  // by "select all on this page" alone.
  const canOfferSelectAllMatching = !selectAllMatching && allOnPageSelected && filteredTotal > subscribers.length;

  function resetSelection() {
    setPageSelected(new Set());
    setSelectAllMatching(false);
    setExcludedIds(new Set());
    setLiveMatchingTotal(null);
  }

  async function openBulkDeleteConfirm() {
    if (!selectAllMatching) {
      setBulkDeleteOpen(true);
      return;
    }
    // Refresh the count right before showing the confirmation — see this
    // state's own comment above for why.
    setIsRefreshingCount(true);
    try {
      const count = await getSubscriberCountForFilter(status);
      setLiveMatchingTotal(count);
    } catch {
      // A failed refresh falls back to the last-known filteredTotal — never
      // blocks the user from opening the dialog at all, and the delete
      // itself is unaffected either way (it re-derives its own target
      // server-side regardless of what this count says).
    } finally {
      setIsRefreshingCount(false);
      setBulkDeleteOpen(true);
    }
  }

  function setStatusFilter(next: "all" | "active" | "unsubscribed") {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("status");
    else params.set("status", next);
    // A filter change always resets to page 1 (Pass 7 §24) — never leaves
    // the viewer stranded on a now-out-of-range page of the new, smaller
    // result set.
    params.delete("subscribersPage");
    router.push(`${pathname}?${params.toString()}`);
    // Pass 8 §2 — a selection (either mode) is only ever meaningful against
    // the filter it was made under; switching filters must never silently
    // carry it over onto a different result set.
    resetSelection();
  }

  function toggleSelectAllOnPage() {
    if (selectAllMatching) {
      // Toggling the header checkbox while cross-page selection is active
      // acts on just this page's rows: if they're all currently included,
      // exclude them; otherwise, (re-)include them. This never changes
      // `selectAllMatching` itself — only which of THIS page's rows count
      // toward the exclusion set.
      setExcludedIds((prev) => {
        const next = new Set(prev);
        if (allOnPageSelected) subscribers.forEach((s) => next.add(s.id));
        else subscribers.forEach((s) => next.delete(s.id));
        return next;
      });
      return;
    }
    setPageSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) subscribers.forEach((s) => next.delete(s.id));
      else subscribers.forEach((s) => next.add(s.id));
      return next;
    });
  }

  function toggleSelected(id: string) {
    if (selectAllMatching) {
      setExcludedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); // re-including a previously-excluded row
        else next.add(id); // excluding a currently-included row
        return next;
      });
      return;
    }
    setPageSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllMatchingFilter() {
    setSelectAllMatching(true);
    setExcludedIds(new Set());
    setPageSelected(new Set());
  }

  function confirmRemoveOne() {
    if (!removeOneId) return;
    const id = removeOneId;
    startTransition(async () => {
      try {
        await deleteSubscriber(id);
        setPageSelected((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        toast.success("Subscriber removed");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove subscriber");
      }
      setRemoveOneId(null);
    });
  }

  function confirmBulkDelete() {
    if (selectAllMatching) {
      startTransition(async () => {
        try {
          const result = await deleteSubscribersMatchingFilter({ status, excludeIds: [...excludedIds] });
          resetSelection();
          toast.success(`${result.deleted} subscriber${result.deleted === 1 ? "" : "s"} removed`);
          router.refresh();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed to remove subscribers");
        }
        setBulkDeleteOpen(false);
      });
      return;
    }
    const ids = [...pageSelected];
    if (ids.length === 0) return;
    startTransition(async () => {
      try {
        const result = await deleteSubscribers(ids);
        setPageSelected(new Set());
        toast.success(`${result.deleted} subscriber${result.deleted === 1 ? "" : "s"} removed`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove subscribers");
      }
      setBulkDeleteOpen(false);
    });
  }

  const removeOneEmail = subscribers.find((s) => s.id === removeOneId)?.email;
  const filterLabel = statusParam === "active" ? "active" : statusParam === "unsubscribed" ? "unsubscribed" : "";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1 rounded-md border p-0.5">
          {(["all", "active", "unsubscribed"] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key)}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${statusParam === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {key === "all" ? `All (${counts.total})` : key === "active" ? `Active (${counts.subscribed})` : `Unsubscribed (${counts.unsubscribed})`}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {selectedCount > 0 && (
            <>
              <span className="text-xs text-muted-foreground">
                {selectAllMatching ? `All ${selectedCount} matching selected` : `${selectedCount} selected on this page`}
              </span>
              <Button variant="destructive" size="sm" className="gap-1.5" onClick={openBulkDeleteConfirm} disabled={isPending || isRefreshingCount}>
                <Trash2 className="h-3.5 w-3.5" /> Remove Selected
              </Button>
            </>
          )}
          <Button size="sm" className="gap-1.5" onClick={() => setBulkAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Add Bulk Subscribers
          </Button>
        </div>
      </div>

      {canOfferSelectAllMatching && (
        // Pass 9 §12 — flex-wrap so the (potentially long, e.g. "Select all
        // 247 active subscribers matching this filter") action text drops
        // to its own line at narrow widths instead of overflowing
        // horizontally alongside the sentence before it — the same
        // flex-wrap convention every other multi-item action row in this
        // app already uses (see PaginationControls' own root, or the
        // Contacts/Leads page header rows).
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs">
          <span>All {subscribers.length} {filterLabel ? `${filterLabel} ` : ""}subscribers on this page are selected.</span>
          <button type="button" onClick={selectAllMatchingFilter} className="font-medium text-info underline underline-offset-2 hover:no-underline">
            Select all {filteredTotal} {filterLabel ? `${filterLabel} ` : ""}subscribers matching this filter
          </button>
        </div>
      )}

      {selectAllMatching && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs">
          <span>
            All {matchingTotal} {filterLabel ? `${filterLabel} ` : ""}subscribers matching this filter are selected
            {excludedIds.size > 0 ? ` (${excludedIds.size} manually deselected)` : ""} — this stays active across pages.
          </span>
          <button type="button" onClick={resetSelection} className="font-medium underline underline-offset-2 hover:no-underline shrink-0">
            Clear selection
          </button>
        </div>
      )}

      {subscribers.length === 0 ? (
        <EmptyState
          icon={Users}
          title={statusParam === "all" ? "No subscribers yet" : statusParam === "active" ? "No active subscribers" : "No unsubscribed subscribers"}
          description={statusParam === "all" ? "Subscribers appear here as visitors sign up on your public website, or add them in bulk." : "Try a different filter."}
        />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false}
                    onCheckedChange={toggleSelectAllOnPage}
                    aria-label="Select all subscribers on this page"
                  />
                </TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Subscribed</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {subscribers.map((s) => (
                <TableRow key={s.id} className="hover:bg-muted/40">
                  <TableCell>
                    <Checkbox checked={selectAllMatching ? !excludedIds.has(s.id) : pageSelected.has(s.id)} onCheckedChange={() => toggleSelected(s.id)} aria-label={`Select ${s.email}`} />
                  </TableCell>
                  <TableCell className="text-sm">{s.email}</TableCell>
                  <TableCell>
                    {s.status === "SUBSCRIBED" ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                        <XCircle className="h-3 w-3" /> Unsubscribed
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.source ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{format(s.subscribedAt, "MMM d, yyyy")}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => setRemoveOneId(s.id)} aria-label={`Remove ${s.email}`} title="Remove subscriber">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmDialog
        open={removeOneId !== null}
        onOpenChange={(open) => !open && setRemoveOneId(null)}
        title="Remove this subscriber?"
        description={`${removeOneEmail ?? "This subscriber"} will be removed from the subscriber list. This only affects the subscriber record — no other CRM data is touched.`}
        confirmLabel="Remove"
        onConfirm={confirmRemoveOne}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={selectAllMatching ? `Delete ${selectedCount} selected subscribers?` : `Remove ${selectedCount} selected subscriber${selectedCount === 1 ? "" : "s"}?`}
        description={
          selectAllMatching
            ? `This deletes every ${filterLabel ? `${filterLabel} ` : ""}subscriber matching the current filter${excludedIds.size > 0 ? `, except the ${excludedIds.size} you manually deselected` : ""} — not just the rows currently on screen. This does not affect any other CRM data.`
            : "Only the selected subscriber records are removed. This does not affect any other CRM data."
        }
        confirmLabel="Remove Selected"
        onConfirm={confirmBulkDelete}
      />

      <BulkSubscriberDialog open={bulkAddOpen} onOpenChange={setBulkAddOpen} />
    </div>
  );
}
