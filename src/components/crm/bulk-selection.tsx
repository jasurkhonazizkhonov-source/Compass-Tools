"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ListPlus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { BulkEnrollDialog, type BulkSequenceOption } from "@/components/crm/bulk-enroll-dialog";
import { bulkDeleteRecords } from "@/server/actions/bulk-selection";
import { BULK_SELECTION_MAX, pageSelectionState, selectionSignature, toggleCurrentPage, type BulkFailure, type BulkRecordKind } from "@/lib/bulk-selection";

/**
 * Checkbox selection for the Leads and Contacts lists.
 *
 * ONE provider wraps the bulk-action bar, the table and the phone cards, so every checkbox shares one selection. The lists stay
 * server-rendered and URL-paginated: the provider receives only the ids of the rows on the current page. Selection lives in
 * component state, which survives page-to-page navigation (the provider stays mounted); it is dropped when the URL's search,
 * filter or sort parameters change (a different result set) and kept when only `page` or `pageSize` changes.
 */
type Ctx = {
  kind: BulkRecordKind;
  selected: ReadonlySet<string>;
  pageIds: readonly string[];
  toggle: (id: string) => void;
  toggleCurrentPage: () => void;
  remove: (ids: readonly string[]) => void;
  clear: () => void;
};
const BulkSelectionContext = createContext<Ctx | null>(null);

function useBulkSelection(): Ctx {
  const ctx = useContext(BulkSelectionContext);
  if (!ctx) throw new Error("Bulk selection controls must be rendered inside <BulkSelectionProvider>");
  return ctx;
}

export function BulkSelectionProvider({ kind, pageIds, children }: { kind: BulkRecordKind; pageIds: readonly string[]; children: React.ReactNode }) {
  const signature = selectionSignature(useSearchParams());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // A different result set (search / filter / sort changed) invalidates a selection made against the old one. Adjusting state during
  // render - not in an effect - so no frame ever shows rows ticked against results they were not selected from.
  const [lastSignature, setLastSignature] = useState(signature);
  if (signature !== lastSignature) {
    setLastSignature(signature);
    setSelected(new Set());
  }

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < BULK_SELECTION_MAX) next.add(id);
      else toast.error(`You can select up to ${BULK_SELECTION_MAX} records at once.`);
      return next;
    });
  }, []);
  const toggleCurrentPageCb = useCallback(() => {
    setSelected((prev) => {
      const { next, capped } = toggleCurrentPage(prev, pageIds, BULK_SELECTION_MAX);
      if (capped) toast.error(`You can select up to ${BULK_SELECTION_MAX} records at once. Deselect some first, or select this page's rows one by one.`);
      return next;
    });
  }, [pageIds]);
  const remove = useCallback((ids: readonly string[]) => {
    setSelected((prev) => {
      if (!ids.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);

  const value = useMemo<Ctx>(() => ({ kind, selected, pageIds, toggle, toggleCurrentPage: toggleCurrentPageCb, remove, clear }), [kind, selected, pageIds, toggle, toggleCurrentPageCb, remove, clear]);
  return <BulkSelectionContext.Provider value={value}>{children}</BulkSelectionContext.Provider>;
}

/** The checkbox at the start of each row (table) or card (phones). */
export function BulkRowCheckbox({ id, label }: { id: string; label: string }) {
  const { selected, toggle } = useBulkSelection();
  return <Checkbox checked={selected.has(id)} onCheckedChange={() => toggle(id)} aria-label={`Select ${label}`} data-testid="bulk-row-checkbox" />;
}

/** The header checkbox: selects / deselects only the rows on the current page; shows a dash when some, but not all, are selected. */
export function BulkSelectAllCheckbox() {
  const { selected, pageIds, toggleCurrentPage: toggleAll } = useBulkSelection();
  const state = pageSelectionState(selected, pageIds);
  return (
    <Checkbox
      checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
      onCheckedChange={toggleAll}
      aria-label="Select all rows on this page"
      data-testid="bulk-select-all"
    />
  );
}

/**
 * Appears only while something is selected. "Add to sequence" is shown to anyone allowed to enroll (the page passes `sequences` only
 * then); "Delete" only to Administrators. Both are enforced again on the server - this is presentation, not the control.
 */
export function BulkActionBar({ canEnroll, canDelete, sequences }: { canEnroll: boolean; canDelete: boolean; sequences: BulkSequenceOption[] }) {
  const { kind, selected, clear, remove } = useBulkSelection();
  const router = useRouter();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFailures, setDeleteFailures] = useState<BulkFailure[] | null>(null);
  const count = selected.size;
  const noun = kind === "leads" ? (count === 1 ? "lead" : "leads") : count === 1 ? "contact" : "contacts";

  async function runDelete() {
    const ids = [...selected];
    const result = await bulkDeleteRecords({ kind, ids });
    if (!result.ok) return { error: result.error };
    remove(result.deletedIds);
    router.refresh();
    if (result.failed.length > 0) {
      setDeleteFailures(result.failed);
      toast.warning(`Deleted ${result.deleted} of ${result.requested}. ${result.failed.length} could not be deleted.`);
    } else {
      toast.success(`Deleted ${result.deleted} ${result.deleted === 1 ? kind.slice(0, -1) : kind}.`);
    }
    return undefined;
  }

  // Stay mounted while a dialog is open: a successful enrollment/deletion empties the selection, but its result must stay on screen.
  if (count === 0 && !deleteFailures && !enrollOpen && !deleteOpen) return null;
  return (
    <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2" data-testid="bulk-action-bar">
      {count > 0 && (
        <>
          <p className="text-sm font-medium" aria-live="polite" data-testid="bulk-selected-count">
            {count} {noun} selected
          </p>
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {canEnroll && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEnrollOpen(true)}>
                <ListPlus className="h-4 w-4" /> Add to sequence
              </Button>
            )}
            {canDelete && (
              <Button size="sm" variant="outline" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
            <Button size="sm" variant="ghost" className="gap-1.5" onClick={clear}>
              <X className="h-4 w-4" /> Clear selection
            </Button>
          </div>
        </>
      )}
      {deleteFailures && (
        <div className="basis-full text-sm" role="status" data-testid="bulk-delete-failures">
          <p className="font-medium text-destructive">{deleteFailures.length} could not be deleted (they stay selected):</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {deleteFailures.slice(0, 10).map((f) => (
              <li key={f.id}>
                {f.label ?? "A selected record"} - {f.reason}
              </li>
            ))}
            {deleteFailures.length > 10 && <li>and {deleteFailures.length - 10} more</li>}
          </ul>
          <Button size="sm" variant="ghost" onClick={() => setDeleteFailures(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {canEnroll && <BulkEnrollDialog open={enrollOpen} onOpenChange={setEnrollOpen} kind={kind} ids={[...selected]} sequences={sequences} onSettled={remove} />}
      {canDelete && (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={`Delete ${count} ${noun}?`}
          confirmLabel={`Delete ${count} ${noun}`}
          description={
            kind === "leads"
              ? `You are about to delete ${count} ${noun}. This will also delete any quotes and bookings created under them. The customers' contact records and their other leads are not affected. This action cannot be undone.`
              : `You are about to delete ${count} ${noun}. This will also delete all of their leads, quotes, bookings, payment methods and activity history. This action cannot be undone.`
          }
          onConfirm={runDelete}
        />
      )}
    </div>
  );
}
