"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/crm/status-badge";
import { BOOKING_STATUS_META } from "@/lib/status-meta";
import { formatMoney } from "@/lib/currency";
import { sendAirlineConfirmationEmail } from "@/server/actions/bookings";
import type { BookingStatus } from "@/generated/prisma/client";

type ConfirmationDisplay = {
  id: string;
  airlineName: string | null;
  confirmationNumber: string;
  eTicketNumbers: string[];
};

export type BookingInformationCardProps = {
  bookingId: string;
  pnr: string | null;
  confirmations: ConfirmationDisplay[];
  status: BookingStatus;
  /** Internal USD-tracking fields (Pass 22) — never the quote's own
   * customer-facing currency. Formatted below via formatMoney(value, "USD"),
   * matching the Booking detail page's own Ticketing card. */
  fareAmount: number | null;
  taxAmount: number | null;
  serviceFeeAmount: number | null;
  profitAmount: number | null;
  internalNotes: string | null;
  hasSentConfirmationBefore: boolean;
};

/**
 * Read-only "Booking Information" panel for the Quote detail page —
 * displays the same PNR / Airline Confirmation Numbers / Ticket Status /
 * Ticket Cost / Taxes / Issuing Fee / Profit / Booking Notes fields already
 * editable on the Booking detail page's own Ticketing card (see
 * BookingTicketingForm's locked/read-only view, which this mirrors), but
 * with no inputs and no Save button — the Booking detail page remains the
 * one place these fields are ever edited; this component is display-only
 * except for the Send/Resend action below.
 *
 * "Send Airline Confirmation" / "Resend Airline Confirmation" calls the
 * exact same sendAirlineConfirmationEmail server action used on the
 * Booking detail page (same first-send-vs-resend label logic, keyed off
 * hasSentConfirmationBefore) — that action independently re-validates the
 * actor's own permission and the booking's row-level visibility on every
 * call, regardless of which page invoked it, so no separate authorization
 * check is duplicated here.
 */
export function BookingInformationCard({
  bookingId,
  pnr,
  confirmations,
  status,
  fareAmount,
  taxAmount,
  serviceFeeAmount,
  profitAmount,
  internalNotes,
  hasSentConfirmationBefore,
}: BookingInformationCardProps) {
  const meta = BOOKING_STATUS_META[status];
  const [sendPending, startSendTransition] = useTransition();
  // Optimistic local flip so a follow-up click in the same session reads as
  // "Resend" immediately after a successful first send, without needing a
  // full page reload — same pattern as booking-ticketing-form.tsx's own
  // `sentBefore` state.
  const [sentBefore, setSentBefore] = useState(hasSentConfirmationBefore);

  const canSendConfirmation = (status === "TICKETED" || status === "CONFIRMED") && confirmations.length > 0;
  const sendDisabledReason =
    status !== "TICKETED" && status !== "CONFIRMED"
      ? "Ticket status must be Ticketed or Confirmed"
      : confirmations.length === 0
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

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-sm font-medium">Booking Information</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <ReadOnlyField label="PNR Information" value={pnr} />
          <div className="col-span-2 space-y-1.5">
            <p className="text-xs text-muted-foreground">
              {confirmations.length > 1 ? "Airline Confirmation Numbers" : "Airline Confirmation #"}
            </p>
            {confirmations.length === 0 ? (
              <p className="text-sm font-medium">—</p>
            ) : (
              <div className="space-y-2">
                {confirmations.map((c) => (
                  <div key={c.id} className="rounded-md border px-3 py-2 text-sm">
                    <p className="font-medium break-words">
                      {c.airlineName ? `${c.airlineName} — ` : ""}
                      {c.confirmationNumber}
                    </p>
                    {c.eTicketNumbers.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-0.5 break-words">
                        E-ticket{c.eTicketNumbers.length > 1 ? "s" : ""}: {c.eTicketNumbers.join(", ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Ticket Status</p>
            <StatusBadge label={meta.label} tone={meta.tone} className="mt-1" />
          </div>
          <ReadOnlyField label="Ticket Cost" value={fareAmount != null ? formatMoney(fareAmount, "USD") : null} />
          <ReadOnlyField label="Taxes" value={taxAmount != null ? formatMoney(taxAmount, "USD") : null} />
          <ReadOnlyField label="Issuing Fee" value={serviceFeeAmount != null ? formatMoney(serviceFeeAmount, "USD") : null} />
          <ReadOnlyField label="Profit (calculated)" value={profitAmount != null ? formatMoney(profitAmount, "USD") : null} />
          <ReadOnlyField label="Booking Notes" value={internalNotes} className="col-span-2" />
        </div>

        <div className="flex items-center gap-2 pt-1">
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
        </div>
      </CardContent>
    </Card>
  );
}

/** Matches bookings/[id]/page.tsx's own private Field component style —
 * duplicated here rather than shared since that one lives in a Server
 * Component and this file is a Client Component (same reasoning
 * booking-ticketing-form.tsx's own ReadOnlyField already gives). */
function ReadOnlyField({ label, value, className }: { label: string; value: string | null; className?: string }) {
  return (
    <div className={className}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium break-words whitespace-pre-wrap">{value || "—"}</p>
    </div>
  );
}
