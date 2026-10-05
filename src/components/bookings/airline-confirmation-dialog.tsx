"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { getAirlineConfirmationRecipients, sendAirlineConfirmationEmail } from "@/server/actions/bookings";
import { safeActionMessage } from "@/lib/safe-action-message";

type Loaded = {
  recipients: Array<{ email: string; sources: Array<"booking-form" | "contact"> }>;
  defaultSelected: string[];
  sender: { fullName: string; email: string } | null;
};

/**
 * "Send / Resend Airline Confirmation" with an explicit customer-recipient choice. Used by the
 * Quote page's Booking Information card and the Booking page's Ticketing card, so both behave
 * identically.
 *
 * The list is loaded from the server when the dialog opens (the booking id is the only thing the
 * browser supplies); it holds only customer addresses — the signed Booking Form address and the
 * Contact's addresses — never a CRM user. The signed Booking Form address is pre-selected; nothing
 * is sent unless at least one address is ticked, and the server re-validates every selection.
 * Every failure is a RETURNED message shown inline — nothing here relies on a thrown server error,
 * which production would mask as an opaque React error.
 */
export function AirlineConfirmationDialog({
  bookingId,
  sentBefore,
  onSent,
}: {
  bookingId: string;
  /** True once a first confirmation went out — the action is then a Resend. */
  sentBefore: boolean;
  onSent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, startSend] = useTransition();
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const verb = sentBefore ? "Resend" : "Send";

  // Loads (or reloads) the address list; called every time the dialog opens, so it always reflects
  // the booking as it is now. A newer open supersedes an older, slower response.
  function load() {
    const myRequest = ++requestId.current;
    setLoading(true);
    setLoaded(null);
    setLoadError(null);
    setFormError(null);
    getAirlineConfirmationRecipients(bookingId)
      .then((res) => {
        if (requestId.current !== myRequest) return;
        setLoaded({ recipients: res.recipients, defaultSelected: res.defaultSelected, sender: res.sender });
        // Every open starts from the documented default — an earlier send's recipients are never
        // silently restored.
        setSelected(new Set(res.defaultSelected));
      })
      .catch((err) => {
        if (requestId.current === myRequest) setLoadError(safeActionMessage(err, "Could not load the customer's email addresses. You may not have permission."));
      })
      .finally(() => {
        if (requestId.current === myRequest) setLoading(false);
      });
  }

  function handleOpenChange(next: boolean) {
    if (sending) return;
    setOpen(next);
    if (next) load();
    else requestId.current++;
  }

  function toggle(email: string) {
    setFormError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  function submit() {
    if (sending || !loaded) return;
    if (selected.size === 0) {
      setFormError("Select at least one email address.");
      return;
    }
    setFormError(null);
    startSend(async () => {
      try {
        const result = await sendAirlineConfirmationEmail(bookingId, { resend: sentBefore, recipients: [...selected] });
        if (!result.ok) {
          setFormError(result.error);
          toast.error(result.error);
          return;
        }
        toast.success(
          `${sentBefore ? "Airline confirmation email resent" : "Airline confirmation email sent"} to ${result.sentTo.length === 1 ? result.sentTo[0] : `${result.sentTo.length} recipients`}`
        );
        setOpen(false);
        onSent();
      } catch (err) {
        const message = safeActionMessage(err, "Failed to send the airline confirmation email. You may not have permission.");
        setFormError(message);
        toast.error(message);
      }
    });
  }

  const allSelected = loaded != null && loaded.recipients.length > 0 && selected.size === loaded.recipients.length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Send className="h-4 w-4" /> {verb} Airline Confirmation
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{verb} Airline Confirmation</DialogTitle>
          <DialogDescription>
            Choose which of the customer&apos;s email addresses should receive the airline confirmation number(s). Only the addresses you tick are emailed — no one else is copied.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading email addresses…
          </p>
        )}

        {loadError && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {loadError}
          </p>
        )}

        {loaded && loaded.recipients.length === 0 && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            This booking has no customer email on file.
          </p>
        )}

        {loaded && loaded.recipients.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-muted-foreground">Send to</Label>
              <div className="flex items-center gap-3 text-xs">
                <button type="button" className="text-primary hover:underline disabled:opacity-50" disabled={allSelected || sending} onClick={() => setSelected(new Set(loaded.recipients.map((r) => r.email)))}>
                  Select all
                </button>
                <button type="button" className="text-primary hover:underline disabled:opacity-50" disabled={selected.size === 0 || sending} onClick={() => setSelected(new Set())}>
                  Select none
                </button>
              </div>
            </div>
            <div className="space-y-1 rounded-md border p-2">
              {loaded.recipients.map((r) => (
                <label key={r.email} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1.5 text-sm hover:bg-muted/50">
                  <Checkbox className="mt-0.5" checked={selected.has(r.email)} onCheckedChange={() => toggle(r.email)} disabled={sending} aria-label={r.email} />
                  <span className="min-w-0">
                    <span className="block break-all">{r.email}</span>
                    <span className="block text-xs text-muted-foreground">
                      {r.sources.includes("booking-form") && r.sources.includes("contact")
                        ? "Booking form · Contact"
                        : r.sources.includes("booking-form")
                          ? "Booking form"
                          : "Contact"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {selected.size === 0 ? "No address selected" : `${selected.size} of ${loaded.recipients.length} selected`}
              {loaded.sender ? ` · Sent from ${loaded.sender.fullName} (${loaded.sender.email})` : ""}
            </p>
          </div>
        )}

        {formError && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {formError}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={sending || !loaded || loaded.recipients.length === 0} className="gap-1.5">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
