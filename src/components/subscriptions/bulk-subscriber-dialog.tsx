"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { z } from "zod";
import { Loader2, CheckCircle2, XCircle, AlertTriangle, Pencil, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { previewBulkSubscribers, createBulkSubscribers, type BulkSubscriberRowResult } from "@/server/actions/subscribers";

// Client-side-only, instant-feedback re-check for a row the user just
// edited — never the actual authority (createBulkSubscribers below always
// re-classifies server-side from the reconstructed text, per this app's
// established "never trust client-cached classification" principle). Same
// validator (`z.string().email()`) the server itself uses, so the instant
// feedback never disagrees with what submission will actually decide.
const emailSchema = z.string().email();

// Part 26 — a real, live-measured performance concern: server-side
// classification of 1,000 emails takes well under 200ms (confirmed via
// live testing), but rendering all 1,000+ rows into the DOM at once is
// what actually gets slow/janky in the browser. Rather than pull in a
// virtualization dependency for what's still an occasional, bounded-size
// (MAX_BULK_SUBSCRIBERS = 2,000) modal, paginate the results table
// client-side — bounds the rendered row count regardless of paste size,
// with zero new dependencies.
const RESULTS_PAGE_SIZE = 150;

const OUTCOME_META: Record<BulkSubscriberRowResult["outcome"], { icon: typeof CheckCircle2; className: string; label: string }> = {
  new: { icon: CheckCircle2, className: "text-success", label: "Valid" },
  already_subscribed: { icon: AlertTriangle, className: "text-warning-foreground", label: "Already subscribed" },
  previously_unsubscribed: { icon: AlertTriangle, className: "text-warning-foreground", label: "Previously unsubscribed" },
  duplicate_in_paste: { icon: AlertTriangle, className: "text-warning-foreground", label: "Duplicate in paste" },
  invalid: { icon: XCircle, className: "text-destructive", label: "Invalid" },
};

/**
 * Add Bulk Subscribers (Parts 4-8, reworked Parts 20-27) — paste many
 * emails (including large, messy Excel-style pastes — see the raised
 * Server Action body-size limit in next.config.ts, the actual root cause
 * of the previously-reported "unexpected response from server" error),
 * review exactly what will happen in a spreadsheet-like table, correct any
 * invalid entries inline, then confirm. Same two-stage "review before
 * commit" pattern Bulk Contacts already established in this app.
 */
export function BulkSubscriberDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [results, setResults] = useState<BulkSubscriberRowResult[] | null>(null);
  // Keyed by row index — only rows the user has actually edited get an
  // entry here. Only "invalid" rows render an editable Input at all (see
  // the render below), so this stays small (a handful of corrections at
  // most) regardless of how many thousand rows the paste produced —
  // deliberately NOT one controlled input per row, which would be the real
  // "excessive re-renders / browser freeze" risk for a large batch.
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [page, setPage] = useState(0);
  const [isPending, startTransition] = useTransition();

  function reset() {
    setText("");
    setResults(null);
    setEdits({});
    setPage(0);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleReview() {
    if (!text.trim()) {
      toast.error("Paste at least one email address first");
      return;
    }
    startTransition(async () => {
      try {
        const res = await previewBulkSubscribers(text);
        if (res.length === 0) {
          toast.error("No email addresses were found in the pasted text");
          return;
        }
        setEdits({});
        setPage(0);
        setResults(res);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not validate the emails");
      }
    });
  }

  // The text actually submitted reflects any inline corrections — each
  // row's (possibly-edited) value, one per line. The server re-classifies
  // this from scratch (createBulkSubscribers never trusts what the client
  // displayed), so an edit that turns out to still be invalid, a
  // duplicate, or already-subscribed is still caught correctly there.
  const effectiveText = useMemo(() => {
    if (!results) return text;
    return results.map((r, i) => edits[i] ?? r.email).join("\n");
  }, [results, edits, text]);

  function handleCreate() {
    startTransition(async () => {
      try {
        const summary = await createBulkSubscribers(effectiveText);
        toast.success(`${summary.created} subscriber${summary.created === 1 ? "" : "s"} added`);
        router.refresh();
        handleOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not add the subscribers — nothing was saved");
      }
    });
  }

  // Optimistic, client-side-only count for the button label — a corrected
  // invalid row that now looks like a real email is counted as likely-new
  // here for a responsive button label, but the actual created count
  // (and the toast afterward) always comes from the server's own
  // re-classification, never this estimate.
  const newCount = useMemo(() => {
    if (!results) return 0;
    return results.filter((r, i) => {
      const value = edits[i] ?? r.email;
      if (r.outcome === "new") return edits[i] == null || emailSchema.safeParse(value).success;
      if (r.outcome === "invalid") return edits[i] != null && emailSchema.safeParse(value).success;
      return false;
    }).length;
  }, [results, edits]);
  const alreadySubscribedCount = results?.filter((r) => r.outcome === "already_subscribed" || r.outcome === "previously_unsubscribed" || r.outcome === "duplicate_in_paste").length ?? 0;
  const invalidCount = useMemo(() => {
    if (!results) return 0;
    return results.filter((r, i) => {
      if (r.outcome !== "invalid") return false;
      const value = edits[i] ?? r.email;
      return !(edits[i] != null && emailSchema.safeParse(value).success);
    }).length;
  }, [results, edits]);

  const pageCount = results ? Math.max(1, Math.ceil(results.length / RESULTS_PAGE_SIZE)) : 1;
  const clampedPage = Math.min(page, pageCount - 1);
  const pageStart = clampedPage * RESULTS_PAGE_SIZE;
  const pageRows = useMemo(() => {
    if (!results) return [];
    return results.slice(pageStart, pageStart + RESULTS_PAGE_SIZE).map((r, offset) => ({ r, i: pageStart + offset }));
  }, [results, pageStart]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bulk Subscriber Import</DialogTitle>
          <DialogDescription>
            Paste email addresses — one per line, separated by commas/semicolons/spaces, or copied directly from a spreadsheet. Surrounding text (like a name) is ignored automatically. Supports large pastes (hundreds or thousands of addresses).
          </DialogDescription>
        </DialogHeader>

        {!results ? (
          // Item 8 — was rows={12}, which left a lot of visibly empty box
          // below a typical short paste before Review is even clicked.
          // rows={7} keeps room for a real multi-line paste (and still
          // scrolls internally for a much longer one) without reading as
          // empty dead space on first open.
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"john@example.com\nmary@example.com\ndavid@example.com"}
            rows={7}
            className="font-mono text-sm"
            autoFocus
          />
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-sm font-medium">{results.length} email{results.length === 1 ? "" : "s"} detected</p>
              <p className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5">
                <span>
                  {newCount} new valid subscriber{newCount === 1 ? "" : "s"} · {alreadySubscribedCount} already subscribed · {invalidCount} invalid
                  {invalidCount > 0 && " — correct these below before importing."}
                </span>
                {invalidCount > 0 && pageCount > 1 && (
                  <button
                    type="button"
                    className="text-destructive underline underline-offset-2 hover:no-underline"
                    onClick={() => {
                      const firstInvalidIndex = results.findIndex((r, i) => {
                        if (r.outcome !== "invalid") return false;
                        const value = edits[i] ?? r.email;
                        return !(edits[i] != null && emailSchema.safeParse(value).success);
                      });
                      if (firstInvalidIndex >= 0) setPage(Math.floor(firstInvalidIndex / RESULTS_PAGE_SIZE));
                    }}
                  >
                    Jump to first invalid row
                  </button>
                )}
              </p>
            </div>
            <div className="max-h-[28rem] overflow-y-auto rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="w-44">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map(({ r, i }) => {
                    const editedValue = edits[i];
                    const isEditing = editedValue != null;
                    const effectiveValue = editedValue ?? r.email;
                    // Only an "invalid" row is ever editable — editing a
                    // "new"/"duplicate"/"already subscribed" row has no
                    // real meaning, and rendering thousands of live
                    // controlled inputs for every row (valid or not) is
                    // exactly the performance trap Part 26 warns against.
                    const editable = r.outcome === "invalid";
                    const nowValid = isEditing && emailSchema.safeParse(effectiveValue).success;
                    const meta = nowValid ? OUTCOME_META.new : OUTCOME_META[r.outcome];
                    const Icon = meta.icon;
                    return (
                      <TableRow key={i}>
                        <TableCell className="text-xs text-muted-foreground tabular-nums">{i + 1}</TableCell>
                        <TableCell className="text-xs">
                          {editable ? (
                            <div className="flex items-center gap-1.5">
                              <Pencil className="h-3 w-3 text-muted-foreground shrink-0" />
                              <Input
                                value={effectiveValue}
                                onChange={(e) => setEdits((prev) => ({ ...prev, [i]: e.target.value }))}
                                className="h-7 text-xs font-mono"
                                aria-label={`Correct email for row ${i + 1}`}
                              />
                            </div>
                          ) : (
                            <span className="font-mono">{r.email}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className={`inline-flex items-center gap-1 text-xs font-medium ${meta.className}`}>
                            <Icon className="h-3.5 w-3.5 shrink-0" />
                            {nowValid ? "Corrected — will be re-checked" : meta.label}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {pageCount > 1 && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Rows {pageStart + 1}-{Math.min(pageStart + RESULTS_PAGE_SIZE, results.length)} of {results.length}
                </p>
                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={clampedPage <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page of results">
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-xs text-muted-foreground tabular-nums">Page {clampedPage + 1} of {pageCount}</span>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={clampedPage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} aria-label="Next page of results">
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {results ? (
            <>
              <Button variant="outline" onClick={() => { setResults(null); setEdits({}); }} disabled={isPending}>Back to Edit</Button>
              <Button onClick={handleCreate} disabled={isPending || newCount === 0} className="gap-1.5">
                {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Add {newCount} Subscriber{newCount === 1 ? "" : "s"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>Cancel</Button>
              <Button onClick={handleReview} disabled={isPending} className="gap-1.5">
                {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Review
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
