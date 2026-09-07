import { redirect } from "next/navigation";

// Pass 12 §28/§30 — the one shared, strict allow-list every paginated
// query in the app validates `pageSize` against. A plain min/max clamp
// would silently accept any value in range (37, 41, ...); a fixed
// allow-list is what actually satisfies "only accept 25/50/75/100, reject
// arbitrary huge values" — anything not exactly one of these four falls
// back to the default rather than being coerced to the nearest bound.
export const PAGE_SIZE_OPTIONS = [25, 50, 75, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

/**
 * Server-side page-size validation shared by every paginated query
 * (Leads/Contacts/Quotes/Bookings/Tasks/Sequences/Sequence Enrollments/
 * Get in Touch/Marketing Campaigns/Subscribers). Never trusts a
 * client-supplied `pageSize` beyond this fixed allow-list — a request for
 * `pageSize=10000` (or `NaN`, negative, fractional, missing) always falls
 * back to DEFAULT_PAGE_SIZE, so no query can ever be forced to fetch an
 * unbounded number of rows no matter what a caller sends.
 */
export function resolvePageSize(requested: number | string | undefined): PageSize {
  const n = typeof requested === "string" ? Number(requested) : requested;
  const truncated = Math.trunc(n ?? DEFAULT_PAGE_SIZE);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(truncated) ? (truncated as PageSize) : DEFAULT_PAGE_SIZE;
}

/**
 * Pass 7 §32/§33 — if the requested page is beyond the last real page (a
 * bookmarked/shared URL after records were deleted, or simply typing a
 * number too high before this request's own data existed), redirect to the
 * nearest valid page instead of silently rendering an empty table under a
 * misleading "Page 50 of 3" state. A no-op when `page` is already in
 * range — every list query already clamps `pageCount` to a minimum of 1,
 * so this only ever fires for a genuinely too-high page, never for a
 * legitimately empty list on page 1.
 *
 * Preserves every other search param (filters/search/sort) exactly as
 * given — only the page param itself is corrected. `pathname` is the
 * calling page's own route (e.g. "/contacts"), passed explicitly since a
 * Server Component doesn't have `usePathname()` available.
 *
 * `pageParam` defaults to "page" — pass an override (e.g. "campaignsPage")
 * when a route hosts more than one independently-paginated list (see
 * PaginationControls' own matching `pageParam` prop), so correcting one
 * list's page never touches the other's.
 */
export function redirectToValidPageIfNeeded(
  sp: Record<string, string | string[] | undefined>,
  pathname: string,
  page: number,
  pageCount: number,
  pageParam: string = "page"
): void {
  if (page <= pageCount) return;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string" && k !== pageParam) params.set(k, v);
  }
  if (pageCount > 1) params.set(pageParam, String(pageCount));
  const qs = params.toString();
  redirect(qs ? `${pathname}?${qs}` : pathname);
}
