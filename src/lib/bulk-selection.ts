// Shared, pure rules for checkbox selection on the Leads and Contacts lists (UI and server use the same numbers and shapes).

export type BulkRecordKind = "leads" | "contacts";

/**
 * The most records one bulk action may touch. The largest list page is 100 rows, so a whole page can always be selected; the same
 * limit is enforced again by the server actions (a client cannot raise it by editing a request).
 */
export const BULK_SELECTION_MAX = 100;

/** One record a bulk action could not process, with a reason a person can act on. `label` is absent when the record is not visible to the user. */
export type BulkFailure = { id: string; label: string | null; reason: string };

export type PageSelectionState = "all" | "some" | "none";

/** How the header checkbox should look for the rows currently on screen. */
export function pageSelectionState(selected: ReadonlySet<string>, pageIds: readonly string[]): PageSelectionState {
  if (pageIds.length === 0) return "none";
  let hits = 0;
  for (const id of pageIds) if (selected.has(id)) hits++;
  return hits === 0 ? "none" : hits === pageIds.length ? "all" : "some";
}

/**
 * Header-checkbox behaviour: if every row on this page is already selected, deselect exactly those rows; otherwise select every row
 * on this page. Rows on other pages are never touched. `capped` is true when adding the whole page would exceed `max` (nothing is
 * added in that case, so a partial, surprising selection is never made).
 */
export function toggleCurrentPage(selected: ReadonlySet<string>, pageIds: readonly string[], max: number = BULK_SELECTION_MAX): { next: Set<string>; capped: boolean } {
  const next = new Set(selected);
  if (pageSelectionState(selected, pageIds) === "all") {
    for (const id of pageIds) next.delete(id);
    return { next, capped: false };
  }
  for (const id of pageIds) next.add(id);
  if (next.size > max) return { next: new Set(selected), capped: true };
  return { next, capped: false };
}

/**
 * The part of the list URL that decides WHICH records are in the result set: everything except the page number and page size.
 * When this changes (a search, a filter, a sort), a selection made against the old result set is dropped; moving between pages or
 * changing the number of rows per page keeps it.
 */
export function selectionSignature(searchParams: { entries(): IterableIterator<[string, string]> } | null | undefined): string {
  if (!searchParams) return "";
  const parts: string[] = [];
  for (const [key, value] of searchParams.entries()) if (key !== "page" && key !== "pageSize") parts.push(`${key}=${value}`);
  return parts.sort().join("&");
}
