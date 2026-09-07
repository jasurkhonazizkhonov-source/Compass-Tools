"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAGE_SIZE_OPTIONS } from "@/lib/pagination";

/**
 * Shared server-side-pagination footer for every paginated CRM list page
 * (Leads/Contacts/Quotes/Bookings/Tasks/Sequences/Sequence Enrollments/Get
 * in Touch/Marketing Campaigns/Subscribers) — a "Showing A–B of N" summary,
 * a Rows-per-page selector (25/50/75/100), Prev/Next, and a direct
 * page-number input. Reads/writes the `pageParam`/`pageSizeParam` query
 * params via the URL (never local component state alone), so every OTHER
 * current query param (status filter, search text, sort, agent filter, ...)
 * is preserved automatically — this component doesn't need to know what
 * filters a given page has, it just carries forward whatever's already in
 * the URL and changes only its own params. Out-of-range input (0, negative,
 * above pageCount, non-numeric) is clamped rather than producing a broken/
 * empty navigation.
 *
 * Pass 12 §29 — this footer is ALWAYS rendered, even when there's only one
 * page (or zero results): the "Showing X–Y of Z" summary and the
 * rows-per-page selector remain visible so the user never has to guess
 * how many rows exist or hunt for a way to see more per page. Only the
 * Prev/Next buttons and the page-number jump — which have nothing useful
 * to do with a single page — are omitted in that case.
 *
 * `pageParam`/`pageSizeParam` default to "page"/"pageSize" — override both
 * (Pass 7/12) when a single route hosts more than one independently-
 * paginated list (e.g. /subscriptions' Marketing Campaigns and Subscribers
 * tables use "campaignsPage"/"campaignsPageSize" and
 * "subscribersPage"/"subscribersPageSize" respectively) so each pager only
 * ever touches its own list's params, never the other's. `label` (also
 * only needed on such a page) disambiguates the Prev/Next/page-input/
 * rows-per-page accessible names — e.g. "Previous page" becomes "Previous
 * campaigns page" — so two pagers on one page never share indistinguishable
 * names.
 */
export function PaginationControls({
  page,
  pageCount,
  total,
  pageSize,
  pageParam = "page",
  pageSizeParam = "pageSize",
  label,
}: {
  page: number;
  pageCount: number;
  /** Total row count across every page — powers the "Showing A–B of N"
   * summary, which is why this and `pageSize` are required, not optional:
   * without them this component can't honestly tell the user what they're
   * looking at. */
  total: number;
  pageSize: number;
  pageParam?: string;
  pageSizeParam?: string;
  label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [inputValue, setInputValue] = useState(String(page));
  // Keep the input in sync when `page` changes via Prev/Next/a fresh
  // navigation — the React-recommended "adjust state during render" form
  // (not an effect): a genuinely new `page` prop resets local edit state
  // synchronously, in the same render, rather than needing an extra effect
  // pass after commit.
  const [lastSyncedPage, setLastSyncedPage] = useState(page);
  if (page !== lastSyncedPage) {
    setLastSyncedPage(page);
    setInputValue(String(page));
  }

  function goToPage(target: number) {
    const clamped = Math.min(Math.max(1, Math.trunc(target) || 1), pageCount);
    const params = new URLSearchParams(searchParams.toString());
    if (clamped <= 1) params.delete(pageParam);
    else params.set(pageParam, String(clamped));
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function changePageSize(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    const parsed = Number(next);
    if (parsed === 25) params.delete(pageSizeParam);
    else params.set(pageSizeParam, String(parsed));
    // Changing how many rows fit per page invalidates the current page
    // offset (page 3 at 25/page is not the same slice at 100/page) — reset
    // to page 1 rather than risk landing on a now out-of-range page.
    params.delete(pageParam);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const parsed = Number(inputValue);
    if (Number.isFinite(parsed)) goToPage(parsed);
    else setInputValue(String(page));
  }

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = total === 0 ? 0 : Math.min(page * pageSize, total);

  return (
    // Pass 8 §4 — a <nav> landmark with an accessible name is the standard
    // native-semantic pattern for a pagination region (WAI-ARIA's own
    // pagination example uses exactly this), not an ARIA attribute bolted
    // onto a plain <div>. `aria-live="polite"` on the "Showing A–B of N"
    // text is what lets a screen-reader user actually hear that the page
    // changed — this is a client-side router.push, so nothing else here
    // would otherwise announce the update the way a full page load
    // naturally does.
    <nav aria-label={label ? `${label} pagination` : "Pagination"} className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Showing {start}–{end} of {total}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <label htmlFor={`pagination-page-size-${pageSizeParam}`} className="sr-only">
            {label ? `Rows per ${label} page` : "Rows per page"}
          </label>
          <span className="hidden sm:inline">Rows per page</span>
          <Select value={String(pageSize)} onValueChange={changePageSize}>
            <SelectTrigger id={`pagination-page-size-${pageSizeParam}`} size="sm" className="h-8 w-[70px]" aria-label={label ? `Rows per ${label} page` : "Rows per page"}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)}>{size}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {pageCount > 1 && (
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => goToPage(page - 1)} aria-label={label ? `Previous ${label} page` : "Previous page"}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {/* A real, visually-hidden <label> (not just aria-label) so the
               * association works consistently across screen readers/browsers
               * — the visible "of Y" text next to the input already tells a
               * sighted user what it's for, so nothing needs to change visually. */}
              <label htmlFor={`pagination-page-input-${pageParam}`} className="sr-only">
                {label ? `Go to ${label} page` : "Go to page"}
              </label>
              <input
                id={`pagination-page-input-${pageParam}`}
                type="number"
                inputMode="numeric"
                min={1}
                max={pageCount}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleInputKeyDown}
                onBlur={() => setInputValue(String(page))}
                className="h-8 w-14 rounded-md border bg-background text-center text-sm tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <span>of {pageCount}</span>
            </div>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page >= pageCount}
              onClick={() => goToPage(page + 1)}
              aria-label={label ? `Next ${label} page` : "Next page"}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
    </nav>
  );
}
