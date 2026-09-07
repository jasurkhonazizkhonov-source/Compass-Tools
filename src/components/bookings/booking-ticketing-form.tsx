"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Save, Send, Megaphone, ShieldAlert, Pencil, X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateBookingTicketing, sendAirlineConfirmationEmail, sendNewSaleNotification, sendCancellationConfirmationEmail, sendCancellationNotification } from "@/server/actions/bookings";
import { computeTotalSellingPriceUsd, computeBookingProfitUsd, formatMoney } from "@/lib/currency";
import type { BookingStatus, QuoteStatus } from "@/generated/prisma/client";
import { AirlineSearchField } from "@/components/crm/airline-search";
import type { AirlineOption } from "@/server/queries/reference-data";

/** Pass 23 — one repeatable "Airline Confirmation Numbers" row. Mirrors
 * `AirlineConfirmationEntry` (src/lib/airline-confirmations.ts) except
 * `eTicketNumbers` stays a single comma-separated string while editing
 * (same convention the old single `tickets` field already used), split
 * into an array only on save, and `airlineName` is carried purely for
 * display in the AirlineSearchField trigger/read-only view — never sent
 * to the server (the server re-resolves the name itself from
 * `airlineIata` when building the email, never trusts a client string). */
type ConfirmationRow = {
  id: string;
  airlineIata: string | null;
  airlineName: string | null;
  confirmationNumber: string;
  eTicketNumbers: string;
};

function newRowId() {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `row-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyRow(): ConfirmationRow {
  return { id: newRowId(), airlineIata: null, airlineName: null, confirmationNumber: "", eTicketNumbers: "" };
}

function toEditableRows(entries: Array<{ id: string; airlineIata: string | null; airlineName: string | null; confirmationNumber: string; eTicketNumbers: string[] }>): ConfirmationRow[] {
  return entries.length
    ? entries.map((e) => ({ id: e.id, airlineIata: e.airlineIata, airlineName: e.airlineName, confirmationNumber: e.confirmationNumber, eTicketNumbers: e.eTicketNumbers.join(", ") }))
    : [emptyRow()];
}

const STATUSES: { value: BookingStatus; label: string }[] = [
  { value: "PENDING_TICKETING", label: "Pending Ticketing" },
  { value: "TICKETED", label: "Ticketed" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "CANCELED", label: "Canceled" },
];

/**
 * Profit is never a client-editable input — it's derived live here purely
 * for display, from the same formula the server recomputes and persists
 * authoritatively in updateBookingTicketing() (see src/lib/currency.ts's
 * computeBookingProfitUsd/computeTotalSellingPriceUsd — the one shared
 * source of truth for this math). Nothing typed into this form is ever
 * trusted as the final profit figure.
 */
export function BookingTicketingForm({
  bookingId,
  pnr,
  airlineConfirmations,
  status,
  fareAmount,
  taxAmount,
  serviceFeeAmount,
  bookingNotes,
  quotePassengerPricing,
  quoteCancellationStatus,
  canEdit,
  hasSentConfirmationBefore,
}: {
  bookingId: string;
  pnr: string | null;
  /** Pass 23 — server-resolved (resolveAirlineConfirmations, already
   * transparently falling back to any pre-Pass-23 legacy single value) and
   * airline-name-enriched (resolveAirlineCodes) for display; empty array
   * means no confirmation has been entered yet. */
  airlineConfirmations: Array<{ id: string; airlineIata: string | null; airlineName: string | null; confirmationNumber: string; eTicketNumbers: string[] }>;
  status: BookingStatus;
  fareAmount: number | null;
  taxAmount: number | null;
  serviceFeeAmount: number | null;
  bookingNotes: string | null;
  quotePassengerPricing: { adults: number; adultPrice: number; children: number; childPrice: number; infants: number; infantPrice: number };
  /** Part 14 — when the quote's cancellation lifecycle has reached
   * CANCELLATION_SUBMITTED (customer has confirmed via the lightweight
   * customer-facing confirm page), this Ticketing Agent gets a distinct
   * "Send Flight Cancellation Confirmation" action — the TRUE final
   * "actually cancelled" email, separate from the normal airline
   * confirmation workflow above. Any other status renders nothing new here. */
  quoteCancellationStatus?: QuoteStatus;
  /** Item 11 — whether the viewer is even allowed to enter edit mode at
   * all, computed server-side via canEnterTicketingInfo (the exact same
   * check updateBookingTicketing already enforces authoritatively) and
   * passed down rather than re-derived client-side. This is purely a UI
   * affordance — hiding the Edit button for an unauthorized viewer, same
   * "server is authoritative, UI just reflects it clearly" convention as
   * account-row-editor.tsx's own canEdit prop. The server action's own
   * check is what actually prevents an unauthorized save; this prop never
   * substitutes for it. */
  canEdit: boolean;
  /** Pass 23 §21-23 — whether a first confirmation email has already been
   * sent for this booking (Booking.airlineConfirmationFirstSentAt !=
   * null), computed server-side. Drives the Send/Resend distinction: the
   * FIRST send is atomically claimed server-side (a genuine
   * Promise.all-safe race guard), while a later, deliberate resend uses a
   * separate, non-blocking action. */
  hasSentConfirmationBefore: boolean;
}) {
  const [pnrValue, setPnrValue] = useState(pnr ?? "");
  const [confirmations, setConfirmations] = useState<ConfirmationRow[]>(() => toEditableRows(airlineConfirmations));
  const [statusValue, setStatusValue] = useState<BookingStatus>(status);
  const [fare, setFare] = useState(fareAmount != null ? String(fareAmount) : "");
  const [tax, setTax] = useState(taxAmount != null ? String(taxAmount) : "");
  const [issuingFee, setIssuingFee] = useState(serviceFeeAmount != null ? String(serviceFeeAmount) : "");
  const [notes, setNotes] = useState(bookingNotes ?? "");
  const [isPending, startTransition] = useTransition();
  const [sendPending, startSendTransition] = useTransition();
  const [notifyPending, startNotifyTransition] = useTransition();
  const [cancelConfirmPending, startCancelConfirmTransition] = useTransition();
  const [cancelNotifyPending, startCancelNotifyTransition] = useTransition();
  // Tracks the LAST SAVED state, separately from the live form values above
  // — lets "Send Airline Confirmation" know whether there are unsaved edits
  // (compared against this) without conflating it with the original props,
  // which go stale the moment the form is first saved in this session.
  const [saved, setSaved] = useState({
    pnr: pnr ?? "",
    confirmations: toEditableRows(airlineConfirmations),
    status,
    fare: fareAmount != null ? String(fareAmount) : "",
    tax: taxAmount != null ? String(taxAmount) : "",
    issuingFee: serviceFeeAmount != null ? String(serviceFeeAmount) : "",
    notes: bookingNotes ?? "",
  });
  const hasUnsavedChanges =
    pnrValue !== saved.pnr ||
    JSON.stringify(confirmations) !== JSON.stringify(saved.confirmations) ||
    statusValue !== saved.status ||
    fare !== saved.fare ||
    tax !== saved.tax ||
    issuingFee !== saved.issuingFee ||
    notes !== saved.notes;

  // Item 11 — locked/edit-toggle behavior. Starts locked (read-only) once
  // any field already has a persisted value; a brand-new booking with
  // nothing saved yet starts in edit mode instead, so there's always a way
  // to enter the very first save (an empty locked view with no data and no
  // way in would be a dead end).
  const hasSavedData = !!(pnr || airlineConfirmations.length > 0 || fareAmount != null || taxAmount != null || serviceFeeAmount != null || bookingNotes);
  const [editing, setEditing] = useState(!hasSavedData);
  // Optimistic local flip so a follow-up click in the same session reads
  // as "Resend" immediately after a successful first send, without
  // needing a full page reload to re-derive it from the server.
  const [sentBefore, setSentBefore] = useState(hasSentConfirmationBefore);

  function cancelEdit() {
    setPnrValue(saved.pnr);
    setConfirmations(saved.confirmations);
    setStatusValue(saved.status);
    setFare(saved.fare);
    setTax(saved.tax);
    setIssuingFee(saved.issuingFee);
    setNotes(saved.notes);
    setEditing(false);
  }

  function addConfirmationRow() {
    setConfirmations((rows) => [...rows, emptyRow()]);
  }
  function removeConfirmationRow(id: string) {
    setConfirmations((rows) => rows.filter((r) => r.id !== id));
  }
  function updateConfirmationRow(id: string, patch: Partial<ConfirmationRow>) {
    setConfirmations((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  const totalSellingPrice = useMemo(() => computeTotalSellingPriceUsd(quotePassengerPricing), [quotePassengerPricing]);
  const liveProfit = useMemo(
    () =>
      computeBookingProfitUsd({
        totalSellingPrice,
        fareAmount: fare ? Number(fare) : undefined,
        taxAmount: tax ? Number(tax) : undefined,
        serviceFeeAmount: issuingFee ? Number(issuingFee) : undefined,
      }),
    [totalSellingPrice, fare, tax, issuingFee]
  );

  function save() {
    startTransition(async () => {
      try {
        const payload = confirmations
          .filter((r) => r.confirmationNumber.trim() !== "")
          .map((r) => ({
            id: r.id,
            airlineIata: r.airlineIata,
            confirmationNumber: r.confirmationNumber.trim(),
            eTicketNumbers: r.eTicketNumbers ? r.eTicketNumbers.split(",").map((t) => t.trim()).filter(Boolean) : [],
          }));
        await updateBookingTicketing({
          bookingId,
          pnr: pnrValue || undefined,
          airlineConfirmations: payload,
          status: statusValue,
          fareAmount: fare ? Number(fare) : undefined,
          taxAmount: tax ? Number(tax) : undefined,
          serviceFeeAmount: issuingFee ? Number(issuingFee) : undefined,
          bookingNotes: notes || undefined,
        });
        toast.success("Booking updated");
        setSaved({ pnr: pnrValue, confirmations, status: statusValue, fare, tax, issuingFee, notes });
        setEditing(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update booking");
      }
    });
  }

  // Part 16/17 — the customer-facing confirmation email is no longer
  // automatic; this sends it on demand. Only meaningful once the ticketing
  // form's current values are actually the SAVED, persisted state (the
  // server action re-fetches the booking fresh, so an unsaved edit here
  // would silently be ignored rather than included — better to require a
  // save first than let the button imply it sends what's currently typed).
  const hasAnyConfirmation = confirmations.some((r) => r.confirmationNumber.trim() !== "");
  const canSendConfirmation =
    (statusValue === "TICKETED" || statusValue === "CONFIRMED") && hasAnyConfirmation && !hasUnsavedChanges;
  const sendDisabledReason = hasUnsavedChanges
    ? "Save your changes first"
    : statusValue !== "TICKETED" && statusValue !== "CONFIRMED"
      ? "Ticket status must be Ticketed or Confirmed"
      : !hasAnyConfirmation
        ? "At least one Airline Confirmation # is required"
        : null;

  function sendConfirmation() {
    startSendTransition(async () => {
      try {
        await sendAirlineConfirmationEmail(bookingId, sentBefore ? { resend: true } : undefined);
        toast.success(sentBefore ? "Airline confirmation email resent to customer" : "Airline confirmation email sent to customer");
        setSentBefore(true);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send airline confirmation email");
      }
    });
  }

  // The internal "new sale" team announcement is no longer sent
  // automatically when ticketing is saved as Confirmed — it's a deliberate,
  // on-demand action so a Ticketing Agent can correct Ticket Cost/Taxes/
  // Issuing Fee (and see the recalculated Profit above update) before
  // announcing the sale to the whole team, rather than the first CONFIRMED
  // save locking in whatever profit figure happened to be typed at that
  // moment. Same "must be saved, not just typed" guard as Send Airline
  // Confirmation — the server re-fetches the persisted booking, so an
  // unsaved edit here would silently be ignored rather than included.
  const canSendNewSale = statusValue === "CONFIRMED" && fare.trim() !== "" && !hasUnsavedChanges;
  const notifyDisabledReason = hasUnsavedChanges
    ? "Save your changes first"
    : statusValue !== "CONFIRMED"
      ? "Ticket status must be Confirmed"
      : fare.trim() === ""
        ? "Ticket Cost is required"
        : null;

  function notifyNewSale() {
    startNotifyTransition(async () => {
      try {
        await sendNewSaleNotification(bookingId);
        toast.success("Team notified of the new sale");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send the new-sale notification");
      }
    });
  }

  // Part 14 — only reachable once the customer has actually confirmed the
  // cancellation via their own View Deal page (CANCELLATION_SUBMITTED). This
  // is the TRUE final "it's actually cancelled" email — distinct from the
  // earlier "scheduled for cancellation, please confirm" email already sent
  // to the customer by an Admin/Manager's separate "Send Cancellation Form"
  // action. Sending this transitions Quote.status to CANCELLATION_CONFIRMED.
  const canSendCancellationConfirmation = quoteCancellationStatus === "CANCELLATION_SUBMITTED";

  function sendCancellationConfirmation() {
    startCancelConfirmTransition(async () => {
      try {
        await sendCancellationConfirmationEmail(bookingId);
        toast.success("Cancellation confirmation sent to customer");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send the cancellation confirmation");
      }
    });
  }

  // Part 16 — only reachable once the cancellation has actually reached its
  // true final state (CANCELLATION_CONFIRMED, set by the action above) —
  // deliberately later/separate from canSendCancellationConfirmation itself,
  // matching this codebase's "deliberate, manual, non-automatic" convention
  // for every team announcement.
  const canNotifyCancellation = quoteCancellationStatus === "CANCELLATION_CONFIRMED";

  function notifyCancellation() {
    startCancelNotifyTransition(async () => {
      try {
        await sendCancellationNotification(bookingId);
        toast.success("Team notified of the cancellation");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send the cancellation notification");
      }
    });
  }

  const savedConfirmations = saved.confirmations.filter((c) => c.confirmationNumber.trim() !== "");

  if (!editing) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <ReadOnlyField label="PNR Information" value={saved.pnr} />
          <div className="col-span-2 space-y-1.5">
            <p className="text-xs text-muted-foreground">{savedConfirmations.length > 1 ? "Airline Confirmation Numbers" : "Airline Confirmation #"}</p>
            {savedConfirmations.length === 0 ? (
              <p className="text-sm font-medium">—</p>
            ) : (
              <div className="space-y-2">
                {savedConfirmations.map((c) => (
                  <div key={c.id} className="rounded-md border px-3 py-2 text-sm">
                    <p className="font-medium break-words">
                      {c.airlineName ? `${c.airlineName} — ` : ""}
                      {c.confirmationNumber}
                    </p>
                    {c.eTicketNumbers.trim() !== "" && (
                      <p className="text-xs text-muted-foreground mt-0.5 break-words">
                        E-ticket{c.eTicketNumbers.includes(",") ? "s" : ""}: {c.eTicketNumbers}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <ReadOnlyField label="Ticket Status" value={STATUSES.find((s) => s.value === saved.status)?.label ?? saved.status} />
          <ReadOnlyField label="Ticket Cost" value={saved.fare ? `$${saved.fare}` : "—"} />
          <ReadOnlyField label="Taxes" value={saved.tax ? `$${saved.tax}` : "—"} />
          <ReadOnlyField label="Issuing Fee" value={saved.issuingFee ? `$${saved.issuingFee}` : "—"} />
          <ReadOnlyField
            label="Profit (calculated)"
            // Pass 28 — was `$${liveProfit.toLocaleString(...)}`, which
            // renders a loss-making sale's negative profit as "$-150.00"
            // instead of "-$150.00" (see formatMoney's own doc comment for
            // the full explanation — this is internal-only USD, but the
            // exact same sign-placement bug this pass already fixed at the
            // source for every OTHER caller of formatMoney).
            value={liveProfit != null ? formatMoney(liveProfit, "USD") : "—"}
          />
          <ReadOnlyField label="Booking Notes" value={saved.notes} className="col-span-2" />
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {canEdit && (
            <Button variant="outline" onClick={() => setEditing(true)} className="gap-2">
              <Pencil className="h-4 w-4" /> Edit
            </Button>
          )}
          <BookingTicketingActionButtons
            sendDisabledReason={sendDisabledReason}
            sendPending={sendPending}
            canSendConfirmation={canSendConfirmation}
            sendConfirmation={sendConfirmation}
            sentBefore={sentBefore}
            notifyDisabledReason={notifyDisabledReason}
            notifyPending={notifyPending}
            canSendNewSale={canSendNewSale}
            notifyNewSale={notifyNewSale}
            canSendCancellationConfirmation={canSendCancellationConfirmation}
            cancelConfirmPending={cancelConfirmPending}
            sendCancellationConfirmation={sendCancellationConfirmation}
            canNotifyCancellation={canNotifyCancellation}
            cancelNotifyPending={cancelNotifyPending}
            notifyCancellation={notifyCancellation}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>PNR Information <span className="text-muted-foreground font-normal">(internal only)</span></Label>
        <Textarea value={pnrValue} onChange={(e) => setPnrValue(e.target.value)} placeholder="e.g. ABCDEF" rows={2} />
      </div>
      {/* Pass 23 §7/§24 — repeatable rows so a booking with multiple
          PNRs/airlines (codeshares, separate outbound/return, multiple
          tickets) can be represented honestly instead of collapsed into
          one field. Airline association is optional — never forced — and
          resolved via the same canonical airline picker used everywhere
          else in the CRM. */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Airline Confirmation Numbers <span className="text-muted-foreground font-normal">(at least one required to confirm)</span></Label>
        </div>
        <div className="space-y-3">
          {confirmations.map((row, i) => (
            <div key={row.id} className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">Confirmation {i + 1}</p>
                {confirmations.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeConfirmationRow(row.id)}
                    aria-label={`Remove confirmation ${i + 1}`}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs font-normal">Confirmation #</Label>
                  <Input
                    value={row.confirmationNumber}
                    onChange={(e) => updateConfirmationRow(row.id, { confirmationNumber: e.target.value.toUpperCase() })}
                    placeholder="e.g. ABC123"
                  />
                </div>
                <div className="space-y-1">
                  {/* aria-labelledby, not a redundant ariaLabel fallback —
                      matches passenger-form.tsx's established pattern for
                      this exact widget (Pass 22 fix). */}
                  <Label className="text-xs font-normal" id={`airline-label-${row.id}`}>Airline (optional)</Label>
                  <AirlineSearchField
                    aria-labelledby={`airline-label-${row.id}`}
                    value={row.airlineIata ? ({ id: 0, iata: row.airlineIata, icao: null, name: row.airlineName ?? row.airlineIata, logoUrl: null } satisfies AirlineOption) : null}
                    onChange={(airline: AirlineOption | null) =>
                      updateConfirmationRow(row.id, { airlineIata: airline?.iata ?? airline?.icao ?? null, airlineName: airline?.name ?? null })
                    }
                    placeholder="Search airline..."
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-normal">E-Ticket Number(s) (optional, comma-separated)</Label>
                <Input
                  value={row.eTicketNumbers}
                  onChange={(e) => updateConfirmationRow(row.id, { eTicketNumbers: e.target.value })}
                  placeholder="0257123456789, 0257123456790"
                />
              </div>
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addConfirmationRow} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> {confirmations.length === 0 ? "Add confirmation number" : "Add another confirmation number"}
        </Button>
      </div>
      <div className="space-y-1.5">
        <Label>Ticket Status</Label>
        <Select value={statusValue} onValueChange={(v) => setStatusValue(v as BookingStatus)}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3 pt-2 border-t">
        <div className="space-y-1.5">
          <Label className="text-xs">Ticket Cost <span className="text-muted-foreground font-normal">(required to confirm)</span></Label>
          <Input type="number" value={fare} onChange={(e) => setFare(e.target.value)} className="h-8" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Taxes</Label>
          <Input type="number" value={tax} onChange={(e) => setTax(e.target.value)} className="h-8" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Issuing Fee</Label>
          <Input type="number" value={issuingFee} onChange={(e) => setIssuingFee(e.target.value)} className="h-8" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Profit <span className="text-muted-foreground font-normal">(calculated)</span></Label>
          <div className="h-8 flex items-center rounded-md border bg-muted px-3 text-sm font-medium tabular-nums">
            {liveProfit != null ? formatMoney(liveProfit, "USD") : "—"}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Booking Notes <span className="text-muted-foreground font-normal">(internal only)</span></Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Internal notes about this booking" rows={3} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={isPending} className="gap-2">
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Booking
        </Button>
        {hasSavedData && (
          <Button variant="outline" onClick={cancelEdit} disabled={isPending} className="gap-2">
            <X className="h-4 w-4" /> Cancel
          </Button>
        )}

        <BookingTicketingActionButtons
          sendDisabledReason={sendDisabledReason}
          sendPending={sendPending}
          canSendConfirmation={canSendConfirmation}
          sendConfirmation={sendConfirmation}
          sentBefore={sentBefore}
          notifyDisabledReason={notifyDisabledReason}
          notifyPending={notifyPending}
          canSendNewSale={canSendNewSale}
          notifyNewSale={notifyNewSale}
          canSendCancellationConfirmation={canSendCancellationConfirmation}
          cancelConfirmPending={cancelConfirmPending}
          sendCancellationConfirmation={sendCancellationConfirmation}
          canNotifyCancellation={canNotifyCancellation}
          cancelNotifyPending={cancelNotifyPending}
          notifyCancellation={notifyCancellation}
        />
      </div>
    </div>
  );
}

/** Item 11 — read-only display for the locked (not-editing) view, matching
 * this page's existing plain label/value `Field` pattern (see
 * bookings/[id]/page.tsx's own private Field component) — duplicated here
 * rather than exported/shared since that one lives in a Server Component
 * and this file is a Client Component. */
function ReadOnlyField({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium break-words whitespace-pre-wrap">{value || "—"}</p>
    </div>
  );
}

/** The four on-demand action buttons (Send Airline Confirmation / Notify
 * Team of New Sale / Send Flight Cancellation Confirmation / Notify Team of
 * Cancellation) — identical in both the locked and editing views (Item 11
 * only locks/unlocks the DATA fields above; these deliberate, manual
 * actions are always available whenever their own preconditions are met,
 * regardless of edit-mode), so this is factored out once rather than
 * duplicated. */
function BookingTicketingActionButtons({
  sendDisabledReason,
  sendPending,
  canSendConfirmation,
  sendConfirmation,
  sentBefore,
  notifyDisabledReason,
  notifyPending,
  canSendNewSale,
  notifyNewSale,
  canSendCancellationConfirmation,
  cancelConfirmPending,
  sendCancellationConfirmation,
  canNotifyCancellation,
  cancelNotifyPending,
  notifyCancellation,
}: {
  sendDisabledReason: string | null;
  sendPending: boolean;
  canSendConfirmation: boolean;
  sendConfirmation: () => void;
  /** Pass 23 §21-23 — swaps the button's label/copy between the atomically-
   * claimed first send and an explicit, always-available resend once a
   * first send has already happened. */
  sentBefore: boolean;
  notifyDisabledReason: string | null;
  notifyPending: boolean;
  canSendNewSale: boolean;
  notifyNewSale: () => void;
  canSendCancellationConfirmation: boolean;
  cancelConfirmPending: boolean;
  sendCancellationConfirmation: () => void;
  canNotifyCancellation: boolean;
  cancelNotifyPending: boolean;
  notifyCancellation: () => void;
}) {
  return (
    <>
      {sendDisabledReason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* A disabled button doesn't fire pointer events for Tooltip's own trigger — wrap it so the explanation still shows on hover. */}
            <span>
              <Button variant="outline" disabled className="gap-2">
                <Send className="h-4 w-4" /> {sentBefore ? "Resend Airline Confirmation" : "Send Airline Confirmation"}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{sendDisabledReason}</TooltipContent>
        </Tooltip>
      ) : (
        <Button variant="outline" onClick={sendConfirmation} disabled={sendPending || !canSendConfirmation} className="gap-2">
          {sendPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {sentBefore ? "Resend Airline Confirmation" : "Send Airline Confirmation"}
        </Button>
      )}

      {notifyDisabledReason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button variant="outline" disabled className="gap-2">
                <Megaphone className="h-4 w-4" /> Notify Team of New Sale
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{notifyDisabledReason}</TooltipContent>
        </Tooltip>
      ) : (
        <Button variant="outline" onClick={notifyNewSale} disabled={notifyPending || !canSendNewSale} className="gap-2">
          {notifyPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />}
          Notify Team of New Sale
        </Button>
      )}

      {canSendCancellationConfirmation && (
        <Button
          variant="outline"
          onClick={sendCancellationConfirmation}
          disabled={cancelConfirmPending}
          className="gap-2 border-destructive/40 text-destructive hover:text-destructive"
        >
          {cancelConfirmPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
          Send Flight Cancellation Confirmation
        </Button>
      )}

      {canNotifyCancellation && (
        <Button
          variant="outline"
          onClick={notifyCancellation}
          disabled={cancelNotifyPending}
          className="gap-2 border-destructive/40 text-destructive hover:text-destructive"
        >
          {cancelNotifyPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Megaphone className="h-4 w-4" />}
          Notify Team of Cancellation
        </Button>
      )}
    </>
  );
}
