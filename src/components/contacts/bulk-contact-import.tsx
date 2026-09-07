"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, X, Trash2, AlertTriangle, CheckCircle2, ArrowLeft, PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { previewBulkContacts, bulkCreateContacts, type BulkContactRowResult } from "@/server/actions/bulk-contacts";
import { parsePasteGrid, classifyPasteRows, detectHeaderColumnMap, hasAnyRecognizedHeaderCell, mapPasteRowsByHeader, matchAssignedUser, type ParsedPasteRow } from "@/lib/bulk-contact-paste";

type Agent = { id: string; fullName: string; email?: string };

type BulkRow = {
  clientId: string;
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
  notes: string;
  assignedAgentId: string;
};

// UI-practicality cap, not a contact-architecture limit — ContactEmail/
// ContactPhone are ordinary rows with no schema-level count restriction.
// Bounded so "+ Add Email"/"+ Add Phone" can't make the table unusably
// wide.
const MAX_EMAIL_COLUMNS = 6;
const MAX_PHONE_COLUMNS = 6;

function emptyRow(emailColumns: number, phoneColumns: number): BulkRow {
  return {
    clientId: crypto.randomUUID(),
    firstName: "",
    lastName: "",
    emails: Array(emailColumns).fill(""),
    phones: Array(phoneColumns).fill(""),
    notes: "",
    assignedAgentId: "",
  };
}

function padTo(values: string[], length: number): string[] {
  if (values.length === length) return values;
  if (values.length > length) return values.slice(0, length);
  return [...values, ...Array(length - values.length).fill("")];
}

export function BulkContactImport({ agents }: { agents: Agent[] }) {
  const router = useRouter();
  const [emailColumns, setEmailColumns] = useState(1);
  const [phoneColumns, setPhoneColumns] = useState(1);
  const [rows, setRows] = useState<BulkRow[]>(() => [emptyRow(1, 1), emptyRow(1, 1), emptyRow(1, 1)]);
  const [bulkAssignId, setBulkAssignId] = useState<string>("");
  const [reviewing, setReviewing] = useState(false);
  const [results, setResults] = useState<BulkContactRowResult[] | null>(null);
  const [creationResult, setCreationResult] = useState<{ created: number; assigned: number } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [confirmRemoveColumn, setConfirmRemoveColumn] = useState<{ kind: "email" | "phone"; index: number } | null>(null);
  // The remove-column ("×") button isn't a declarative sibling of its own
  // confirmation dialog (it lives in a mapped table header, far from where
  // the dialog renders), so it can't use <DialogTrigger>'s automatic
  // focus-restoration — same situation, same fix, as AccountStatusSwitch's
  // manual ref approach elsewhere in this app.
  const removeColumnTriggerRef = useRef<HTMLElement | null>(null);
  const wasRemoveColumnDialogOpen = useRef(false);
  useEffect(() => {
    const isOpen = confirmRemoveColumn !== null;
    if (wasRemoveColumnDialogOpen.current && !isOpen) removeColumnTriggerRef.current?.focus();
    wasRemoveColumnDialogOpen.current = isOpen;
  }, [confirmRemoveColumn]);

  function updateField(clientId: string, key: "firstName" | "lastName" | "notes" | "assignedAgentId", value: string) {
    setRows((prev) => prev.map((r) => (r.clientId === clientId ? { ...r, [key]: value } : r)));
  }

  function updateEmail(clientId: string, index: number, value: string) {
    setRows((prev) => prev.map((r) => (r.clientId === clientId ? { ...r, emails: r.emails.map((e, i) => (i === index ? value : e)) } : r)));
  }

  function updatePhone(clientId: string, index: number, value: string) {
    setRows((prev) => prev.map((r) => (r.clientId === clientId ? { ...r, phones: r.phones.map((p, i) => (i === index ? value : p)) } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow(emailColumns, phoneColumns)]);
  }

  function addEmailColumn() {
    if (emailColumns >= MAX_EMAIL_COLUMNS) return;
    setEmailColumns((c) => c + 1);
    setRows((prev) => prev.map((r) => ({ ...r, emails: [...r.emails, ""] })));
  }

  function addPhoneColumn() {
    if (phoneColumns >= MAX_PHONE_COLUMNS) return;
    setPhoneColumns((c) => c + 1);
    setRows((prev) => prev.map((r) => ({ ...r, phones: [...r.phones, ""] })));
  }

  // The single remaining Email/Phone column is never removable (Part 4's
  // "default column cannot be removed... if that would break the contact
  // structure") — every row always needs at least one slot to hold its
  // primary email/phone. Removing any OTHER column, by its own index, is
  // otherwise unrestricted — Part 4's own example removes "Email 4"
  // specifically, not just always the last one.
  function requestRemoveEmailColumn(index: number, triggerEl: HTMLElement) {
    if (emailColumns <= 1) return;
    if (rows.some((r) => r.emails[index]?.trim())) {
      removeColumnTriggerRef.current = triggerEl;
      setConfirmRemoveColumn({ kind: "email", index });
    } else {
      removeEmailColumn(index);
    }
  }

  function requestRemovePhoneColumn(index: number, triggerEl: HTMLElement) {
    if (phoneColumns <= 1) return;
    if (rows.some((r) => r.phones[index]?.trim())) {
      removeColumnTriggerRef.current = triggerEl;
      setConfirmRemoveColumn({ kind: "phone", index });
    } else {
      removePhoneColumn(index);
    }
  }

  function removeEmailColumn(index: number) {
    setEmailColumns((c) => c - 1);
    setRows((prev) => prev.map((r) => ({ ...r, emails: r.emails.filter((_, i) => i !== index) })));
  }

  function removePhoneColumn(index: number) {
    setPhoneColumns((c) => c - 1);
    setRows((prev) => prev.map((r) => ({ ...r, phones: r.phones.filter((_, i) => i !== index) })));
  }

  function confirmRemoveColumnAction() {
    if (!confirmRemoveColumn) return;
    if (confirmRemoveColumn.kind === "email") removeEmailColumn(confirmRemoveColumn.index);
    else removePhoneColumn(confirmRemoveColumn.index);
    setConfirmRemoveColumn(null);
  }

  // Row deletion — individual or bulk — only ever removes rows from THIS
  // component's own local React state. Nothing here touches the database:
  // an unsaved row has no contactId at all, and the only path that ever
  // writes a Contact is bulkCreateContacts(), called exclusively from
  // handleCreate() below. Once that succeeds, this whole workspace is
  // abandoned (redirect to /contacts) rather than continuing to edit
  // "rows" that are now real, separately-managed CRM contacts — so there
  // is no code path, here or anywhere else in this component, that can
  // reach an already-created contact.
  function removeRow(clientId: string) {
    setRows((prev) => {
      const next = prev.filter((r) => r.clientId !== clientId);
      return next.length > 0 ? next : [emptyRow(emailColumns, phoneColumns)];
    });
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(clientId);
      return next;
    });
  }

  function deleteSelectedRows() {
    setRows((prev) => {
      const next = prev.filter((r) => !selected.has(r.clientId));
      return next.length > 0 ? next : [emptyRow(emailColumns, phoneColumns)];
    });
    setSelected(new Set());
    setConfirmDeleteOpen(false);
  }

  function toggleSelected(clientId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.clientId));
  const someSelected = selected.size > 0 && !allSelected;

  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.clientId)));
  }

  /** Excel/Google Sheets paste support (Part 12) — a multi-cell paste is
   * content-classified by bulk-contact-paste.ts rather than mapped by
   * fixed column position, so it works regardless of how many Email/Phone
   * columns the pasted data has relative to the table's current column
   * count, and automatically grows the table's columns to fit (rather
   * than silently dropping data that doesn't fit the current layout). A
   * plain single-cell paste (no tabs/newlines) is left to the browser's
   * normal paste behavior.
   *
   * Header-based mapping (Part 9) is tried first, regardless of which
   * cell the paste started in — a recognized header row is self-describing
   * (it names every column itself), so arbitrary column order ("Last Name
   * | Email | First Name | Phone | Notes") is handled correctly without
   * caring where in the target table the paste happened to start. It only
   * activates when EVERY non-blank header cell is confidently recognized
   * (detectHeaderColumnMap's own strict rule); otherwise this falls back
   * to the existing position/content-sniffing path, with a toast
   * explaining why when the row looked like an attempted header that
   * wasn't fully recognized (never a silent strategy switch). */
  function handlePaste(e: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>, rowIndex: number, columnKey: "firstName" | "lastName" | "email" | "phone" | "notes" | "assignedAgentId") {
    const text = e.clipboardData.getData("text/plain");
    const grid = parsePasteGrid(text);
    if (grid.length === 1 && grid[0].length === 1) return; // plain single-value paste — let the browser handle it normally

    e.preventDefault();
    // Assigned User is never paste-populated by ITSELF (pasting directly
    // into that column, with no header) — matching a freeform pasted name
    // reliably needs the header-mapping path below to know a cell IS an
    // Assigned User value rather than, say, a last name; use "Assign
    // selected rows to..." for a bare paste into this column.
    if (columnKey === "assignedAgentId") return;

    const headerColumnMap = detectHeaderColumnMap(grid[0]);
    let parsedRows: (ParsedPasteRow & { assignedUserRaw?: string })[];
    let targetStartRowIndex = rowIndex;

    if (headerColumnMap) {
      parsedRows = mapPasteRowsByHeader(grid, headerColumnMap);
      targetStartRowIndex = rowIndex; // a header paste is a self-contained block — still lands at the row the paste started on
    } else {
      if (hasAnyRecognizedHeaderCell(grid[0]) && grid[0].length > 1) {
        toast.warning("Some column headers weren't recognized — using automatic detection instead of header mapping.");
      }
      parsedRows = classifyPasteRows(grid, columnKey === "firstName");
    }

    const maxEmails = Math.max(emailColumns, ...parsedRows.map((r) => r.emails.length));
    const maxPhones = Math.max(phoneColumns, ...parsedRows.map((r) => r.phones.length));
    if (maxEmails > emailColumns) setEmailColumns(maxEmails);
    if (maxPhones > phoneColumns) setPhoneColumns(maxPhones);

    let assignedMatchedCount = 0;
    let assignedAttemptedCount = 0;

    setRows((prev) => {
      const next = prev.map((r) => ({ ...r, emails: padTo(r.emails, maxEmails), phones: padTo(r.phones, maxPhones) }));
      parsedRows.forEach((parsed, gridRowOffset) => {
        const targetRowIndex = targetStartRowIndex + gridRowOffset;
        while (targetRowIndex >= next.length) next.push(emptyRow(maxEmails, maxPhones));

        const existing = next[targetRowIndex];
        const updated: BulkRow = { ...existing };
        if (headerColumnMap || columnKey === "firstName") {
          updated.firstName = parsed.firstName || existing.firstName;
          updated.lastName = parsed.lastName || existing.lastName;
        }
        if (parsed.emails.length > 0) updated.emails = padTo(parsed.emails, maxEmails);
        if (parsed.phones.length > 0) updated.phones = padTo(parsed.phones, maxPhones);
        if (parsed.notes) updated.notes = existing.notes ? `${existing.notes} ${parsed.notes}` : parsed.notes;
        if (parsed.assignedUserRaw) {
          assignedAttemptedCount++;
          const matchedId = matchAssignedUser(parsed.assignedUserRaw, agents);
          if (matchedId) {
            assignedMatchedCount++;
            updated.assignedAgentId = matchedId;
          }
        }
        next[targetRowIndex] = updated;
      });
      return next;
    });

    toast.success(`Pasted ${parsedRows.length} row${parsedRows.length === 1 ? "" : "s"}`);
    if (assignedAttemptedCount > 0) {
      const unmatched = assignedAttemptedCount - assignedMatchedCount;
      if (unmatched > 0) {
        toast.info(`Assigned User: ${assignedMatchedCount} of ${assignedAttemptedCount} matched automatically — ${unmatched} could not be confidently matched and need manual assignment.`);
      } else {
        toast.success(`Assigned User: all ${assignedMatchedCount} matched automatically.`);
      }
    }
  }

  function applyBulkAssign() {
    if (!bulkAssignId) return;
    const targetIds = selected.size > 0 ? selected : new Set(rows.map((r) => r.clientId));
    setRows((prev) => prev.map((r) => (targetIds.has(r.clientId) ? { ...r, assignedAgentId: bulkAssignId } : r)));
    toast.success(`Assigned ${targetIds.size} row${targetIds.size === 1 ? "" : "s"}`);
  }

  // Enter moves focus to the same column, next row — standard spreadsheet
  // behavior. Tab already does the right thing for free (native DOM focus
  // order across the row's cells), so it isn't intercepted here.
  function handleCellKeyDown(e: React.KeyboardEvent, rowIndex: number, colKey: string) {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    const el = document.querySelector<HTMLElement>(`[data-row-index="${rowIndex + 1}"][data-col-key="${CSS.escape(colKey)}"]`);
    el?.focus();
  }

  // Rows with literally nothing entered are simply dropped before review/
  // submission — an admin pasting 25 rows into a 30-row table shouldn't
  // have to manually delete the leftover blanks, and an all-blank row has
  // nothing for the server to validate anyway (Part 20's "empty row" case).
  const nonEmptyRows = useMemo(
    () => rows.filter((r) => r.firstName.trim() || r.lastName.trim() || r.emails.some((e) => e.trim()) || r.phones.some((p) => p.trim())),
    [rows]
  );

  function toRowInput(r: BulkRow) {
    return {
      clientId: r.clientId,
      firstName: r.firstName,
      lastName: r.lastName,
      emails: r.emails.filter((e) => e.trim()),
      phones: r.phones.filter((p) => p.trim()),
      notes: r.notes || undefined,
      assignedAgentId: r.assignedAgentId || undefined,
    };
  }

  function handleReview() {
    if (nonEmptyRows.length === 0) {
      toast.error("Add at least one contact first");
      return;
    }
    startTransition(async () => {
      try {
        const res = await previewBulkContacts(nonEmptyRows.map(toRowInput));
        setResults(res);
        setReviewing(true);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not validate the import");
      }
    });
  }

  const resultByClientId = useMemo(() => new Map((results ?? []).map((r) => [r.clientId, r])), [results]);
  const allIssues = useMemo(() => (results ?? []).flatMap((r) => r.issues), [results]);
  const invalidEmailCount = allIssues.filter((i) => i.field === "email").length;
  const invalidPhoneCount = allIssues.filter((i) => i.field === "phone").length;
  const duplicateRowCount = (results ?? []).filter((r) => r.possibleDuplicates.length > 0).length;
  const errorRowCount = (results ?? []).filter((r) => r.issues.length > 0).length;
  const validCount = nonEmptyRows.length - errorRowCount;
  const hasBlockingErrors = errorRowCount > 0;

  function handleCreate() {
    if (hasBlockingErrors || isPending) return;
    startTransition(async () => {
      try {
        const submittedRows = nonEmptyRows;
        const summary = await bulkCreateContacts(submittedRows.map(toRowInput));
        const assignedCount = submittedRows.filter((r) => r.assignedAgentId).length;
        setCreationResult({ created: summary.created, assigned: assignedCount });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not create the contacts — nothing was saved");
      }
    });
  }

  function startNewImport() {
    setRows([emptyRow(1, 1), emptyRow(1, 1), emptyRow(1, 1)]);
    setEmailColumns(1);
    setPhoneColumns(1);
    setSelected(new Set());
    setResults(null);
    setReviewing(false);
    setCreationResult(null);
  }

  if (creationResult) {
    const unassigned = creationResult.created - creationResult.assigned;
    return (
      <div className="rounded-lg border bg-card p-6 sm:p-8 space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
          <PartyPopper className="h-6 w-6" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Contacts created successfully</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {creationResult.created} contact{creationResult.created === 1 ? " was" : "s were"} created.
            <br />
            {creationResult.assigned} contact{creationResult.assigned === 1 ? " was" : "s were"} assigned successfully{unassigned > 0 ? ` · ${unassigned} left unassigned` : ""}.
            <br />
            0 rows failed.
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" onClick={startNewImport}>Import More</Button>
          <Button onClick={() => router.push("/contacts")}>Go to Contacts</Button>
        </div>
      </div>
    );
  }

  if (reviewing) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-lg font-semibold">Review Import</h2>
            <p className="text-sm text-muted-foreground">
              {nonEmptyRows.length} row{nonEmptyRows.length === 1 ? "" : "s"} ready · {validCount} valid
              {errorRowCount > 0 && <span className="text-destructive"> · {errorRowCount} need{errorRowCount === 1 ? "s" : ""} attention</span>}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {invalidEmailCount > 0 && <span>{invalidEmailCount} invalid email address{invalidEmailCount === 1 ? "" : "es"} · </span>}
              {invalidPhoneCount > 0 && <span>{invalidPhoneCount} invalid phone number{invalidPhoneCount === 1 ? "" : "s"} · </span>}
              {duplicateRowCount} possible duplicate{duplicateRowCount === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setReviewing(false)} disabled={isPending}>
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Edit
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={hasBlockingErrors || isPending} className="gap-1.5">
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {hasBlockingErrors ? `${errorRowCount} Row${errorRowCount === 1 ? " Needs" : "s Need"} Correction` : `Create ${validCount} Contact${validCount === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border bg-card divide-y">
          {nonEmptyRows.map((r, i) => {
            const result = resultByClientId.get(r.clientId);
            const hasIssues = !!result && result.issues.length > 0;
            const hasDupes = !!result && result.possibleDuplicates.length > 0;
            return (
              <div key={r.clientId} className="p-3 sm:p-4 flex items-start gap-3">
                {hasIssues ? (
                  <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-success shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    <span className="text-muted-foreground font-normal">#{i + 1}</span>{" "}
                    {r.firstName || <span className="text-muted-foreground italic">No first name</span>} {r.lastName}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {r.emails.filter(Boolean).join(", ") || "—"} · {r.phones.filter(Boolean).join(", ") || "—"}
                  </p>
                  {hasIssues && (
                    <ul className="mt-1.5 space-y-0.5">
                      {result!.issues.map((issue, idx) => (
                        <li key={idx} className="text-xs text-destructive">{issue.message}</li>
                      ))}
                    </ul>
                  )}
                  {!hasIssues && hasDupes && (
                    <ul className="mt-1.5 space-y-0.5">
                      {result!.possibleDuplicates.map((d, idx) => (
                        <li key={idx} className="text-xs text-warning-foreground">Possible duplicate — {d}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
        <p>Paste directly from Excel or Google Sheets, starting at the First Name cell — email- and phone-shaped values are recognized automatically, and Email/Phone columns are added if the pasted data needs more than are currently shown.</p>
        <p>International phone numbers need a leading &quot;+&quot; and country code (e.g. +1 415 555 0100) — a number without one can&apos;t be confidently assigned a country and will need review.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={bulkAssignId} onValueChange={setBulkAssignId}>
          <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Assign selected rows to..." /></SelectTrigger>
          <SelectContent>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={applyBulkAssign} disabled={!bulkAssignId}>
          {selected.size > 0 ? `Assign ${selected.size} selected` : "Assign all rows"}
        </Button>

        <div className="w-px h-5 bg-border mx-1" />

        <Button variant="outline" size="sm" onClick={toggleSelectAll}>
          {allSelected ? "Deselect All" : "Select All"}
        </Button>
        {selected.size > 0 && (
          <>
            <span className="text-xs text-muted-foreground">{selected.size} row{selected.size === 1 ? "" : "s"} selected</span>
            <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
              {/* DialogTrigger (not a plain onClick) so focus correctly
                  restores here on close — see cancellation-dialog.tsx's own
                  comment for why that matters and why this pattern is safe
                  (this button, unlike a Switch, always opens the dialog
                  unconditionally). */}
              <DialogTrigger asChild>
                <Button variant="destructive" size="sm" className="gap-1.5">
                  <Trash2 className="h-3.5 w-3.5" /> Delete Selected
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete {selected.size} selected row{selected.size === 1 ? "" : "s"}?</DialogTitle>
                  <DialogDescription>
                    These rows have not been created as contacts yet and will be removed from this bulk-import workspace. Existing CRM contacts are never affected.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirmDeleteOpen(false)}>Cancel</Button>
                  <Button variant="destructive" onClick={deleteSelectedRows}>Delete Selected</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </div>

      <Dialog open={confirmRemoveColumn !== null} onOpenChange={(open) => !open && setConfirmRemoveColumn(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this {confirmRemoveColumn?.kind === "phone" ? "phone" : "email"} column?</DialogTitle>
            <DialogDescription>
              Any information entered in this column will be removed from the current bulk-contact draft. This does not affect any existing CRM contacts.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemoveColumn(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmRemoveColumnAction}>Remove Column</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          {/* No sticky header: tried (both on the <tr> and on each <th>
              individually) and confirmed genuinely broken during testing —
              the header detached from the table and rendered overlapping
              tbody. Root cause: this wrapper's overflow-x-auto (required —
              Part 19's explicit "horizontal scrolling inside the table
              container, not the page") forces overflow-y to also become a
              scroll container per the CSS spec, which breaks sticky's
              containing-block calculation since this div has no actual
              fixed height to scroll within. A sticky header was only ever
              a "consider" in the spec, and directly conflicts with the
              required scroll-containment behavior — kept the working
              (non-sticky) header rather than the broken one. */}
          <thead>
            <tr className="border-b bg-muted text-left text-xs text-muted-foreground">
              <th className="bg-muted p-2 w-8">
                <Checkbox
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all rows"
                />
              </th>
              <th className="bg-muted p-2 w-10 text-right">#</th>
              <th className="bg-muted p-2 min-w-[120px]">First Name</th>
              <th className="bg-muted p-2 min-w-[120px]">Last Name</th>
              {Array.from({ length: emailColumns }, (_, i) => (
                <th key={`email-${i}`} className="bg-muted p-2 min-w-[180px]">
                  <div className="flex items-center justify-between gap-1">
                    <span>Email{emailColumns > 1 ? ` ${i + 1}` : ""}</span>
                    {emailColumns > 1 && (
                      <button type="button" onClick={(e) => requestRemoveEmailColumn(i, e.currentTarget)} aria-label={`Remove Email ${i + 1} column`} className="text-muted-foreground hover:text-destructive shrink-0">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </th>
              ))}
              {Array.from({ length: phoneColumns }, (_, i) => (
                <th key={`phone-${i}`} className="bg-muted p-2 min-w-[150px]">
                  <div className="flex items-center justify-between gap-1">
                    <span>Phone{phoneColumns > 1 ? ` Number ${i + 1}` : " Number"}</span>
                    {phoneColumns > 1 && (
                      <button type="button" onClick={(e) => requestRemovePhoneColumn(i, e.currentTarget)} aria-label={`Remove Phone Number ${i + 1} column`} className="text-muted-foreground hover:text-destructive shrink-0">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </th>
              ))}
              <th className="bg-muted p-2 min-w-[160px]">Notes</th>
              <th className="bg-muted p-2 min-w-[190px]">Assigned User</th>
              <th className="bg-muted p-2 w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={row.clientId} className={`border-b last:border-0 hover:bg-muted/20 ${selected.has(row.clientId) ? "bg-accent/40" : ""}`}>
                <td className="p-2">
                  <Checkbox checked={selected.has(row.clientId)} onCheckedChange={() => toggleSelected(row.clientId)} aria-label={`Select row ${rowIndex + 1}`} />
                </td>
                <td className="p-2 text-right text-xs text-muted-foreground tabular-nums">{rowIndex + 1}</td>
                <td className="p-1">
                  <Input
                    value={row.firstName}
                    onChange={(e) => updateField(row.clientId, "firstName", e.target.value)}
                    onPaste={(e) => handlePaste(e, rowIndex, "firstName")}
                    onKeyDown={(e) => handleCellKeyDown(e, rowIndex, "firstName")}
                    data-row-index={rowIndex}
                    data-col-key="firstName"
                    className="h-8 text-sm"
                  />
                </td>
                <td className="p-1">
                  <Input
                    value={row.lastName}
                    onChange={(e) => updateField(row.clientId, "lastName", e.target.value)}
                    onPaste={(e) => handlePaste(e, rowIndex, "lastName")}
                    onKeyDown={(e) => handleCellKeyDown(e, rowIndex, "lastName")}
                    data-row-index={rowIndex}
                    data-col-key="lastName"
                    className="h-8 text-sm"
                  />
                </td>
                {row.emails.map((value, i) => (
                  <td key={`email-${i}`} className="p-1">
                    <Input
                      value={value}
                      onChange={(e) => updateEmail(row.clientId, i, e.target.value)}
                      onPaste={(e) => handlePaste(e, rowIndex, "email")}
                      onKeyDown={(e) => handleCellKeyDown(e, rowIndex, `email-${i}`)}
                      data-row-index={rowIndex}
                      data-col-key={`email-${i}`}
                      className="h-8 text-sm"
                    />
                  </td>
                ))}
                {row.phones.map((value, i) => (
                  <td key={`phone-${i}`} className="p-1">
                    <Input
                      value={value}
                      onChange={(e) => updatePhone(row.clientId, i, e.target.value)}
                      onPaste={(e) => handlePaste(e, rowIndex, "phone")}
                      onKeyDown={(e) => handleCellKeyDown(e, rowIndex, `phone-${i}`)}
                      data-row-index={rowIndex}
                      data-col-key={`phone-${i}`}
                      className="h-8 text-sm"
                    />
                  </td>
                ))}
                <td className="p-1">
                  <Textarea
                    value={row.notes}
                    onChange={(e) => updateField(row.clientId, "notes", e.target.value)}
                    onPaste={(e) => handlePaste(e, rowIndex, "notes")}
                    rows={1}
                    className="min-h-8 h-8 resize-none text-sm"
                  />
                </td>
                <td className="p-1">
                  <Select value={row.assignedAgentId || "none"} onValueChange={(v) => updateField(row.clientId, "assignedAgentId", v === "none" ? "" : v)}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {agents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>{a.fullName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="p-2">
                  <Button variant="ghost" size="icon-sm" onClick={() => removeRow(row.clientId)} disabled={rows.length === 1} aria-label={`Remove row ${rowIndex + 1}`}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={addRow} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add Row
          </Button>
          <Button variant="outline" size="sm" onClick={addEmailColumn} disabled={emailColumns >= MAX_EMAIL_COLUMNS} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add Email
          </Button>
          <Button variant="outline" size="sm" onClick={addPhoneColumn} disabled={phoneColumns >= MAX_PHONE_COLUMNS} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add Phone
          </Button>
        </div>
        <Button onClick={handleReview} disabled={isPending} className="gap-1.5">
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Review Import
        </Button>
      </div>
    </div>
  );
}
