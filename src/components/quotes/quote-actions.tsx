"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send, Ban, Loader2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { sendQuote, cancelQuote } from "@/server/actions/quotes";
import { NON_CANCELABLE_QUOTE_STATUSES } from "@/lib/quote-cancelability";
import type { QuoteStatus } from "@/generated/prisma/client";

export function QuoteActions({
  quoteId,
  status,
  emails,
  viewDealUrl,
}: {
  quoteId: string;
  status: QuoteStatus;
  /** Every email address on file for this quote's customer — Part 17-19. */
  emails: string[];
  viewDealUrl: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set(emails[0] ? [emails[0]] : []));
  const router = useRouter();

  function toggleRecipient(addr: string) {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }

  // sendQuote's own side effects (freezing pricingSnapshot, setting
  // sentByAgentId once) are idempotent — safe to call once per selected
  // recipient rather than needing a new multi-recipient code path on the
  // server. Each call still validates its one address against the
  // contact's known emails server-side (never trusts the client).
  async function doSend(recipients: string[]) {
    const results = await Promise.all(recipients.map((r) => sendQuote(quoteId, r)));
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      toast.success(recipients.length > 1 ? `Quote sent to both addresses` : `Quote sent to ${recipients[0]}`);
      setPickerOpen(false);
      router.refresh();
    } else {
      toast.error(`Unable to send: ${failed[0].error}`);
    }
  }

  function handleSend() {
    if (emails.length === 0) {
      toast.error("This customer has no email address on file.");
      return;
    }
    if (emails.length > 1) {
      // Part 19 — never silently pick one when more than one exists; the
      // agent must explicitly confirm the intended recipient(s).
      setSelectedEmails(new Set(emails[0] ? [emails[0]] : []));
      setPickerOpen(true);
      return;
    }
    startTransition(async () => { await doSend(emails); });
  }

  function handleCancel() {
    startTransition(async () => {
      await cancelQuote(quoteId);
      toast.success("Quote canceled");
      router.refresh();
    });
  }

  function copyLink() {
    navigator.clipboard.writeText(viewDealUrl);
    setCopied(true);
    toast.success("Secure quote link copied");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={copyLink} className="gap-1.5">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        Copy Quote Link
      </Button>
      {(status === "DRAFT" || status === "SENT" || status === "EXCHANGE_APPROVED") && (
        <Button size="sm" onClick={handleSend} disabled={isPending} className="gap-1.5">
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {status === "EXCHANGE_APPROVED" ? "Send Exchange Proposal" : status === "DRAFT" ? "Send Quote" : "Resend Quote"}
        </Button>
      )}
      {!NON_CANCELABLE_QUOTE_STATUSES.has(status) && (
        <Button variant="destructive" size="sm" onClick={handleCancel} disabled={isPending} className="gap-1.5">
          <Ban className="h-3.5 w-3.5" /> Cancel Quote
        </Button>
      )}

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Choose a recipient</DialogTitle>
            <DialogDescription>
              This customer has more than one email address on file. Select where to send this quote — or both.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Send quote to</label>
            <div className="space-y-1 rounded-md border p-2">
              {emails.map((e) => (
                <label key={e} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted/50 cursor-pointer">
                  <Checkbox checked={selectedEmails.has(e)} onCheckedChange={() => toggleRecipient(e)} />
                  <span className="truncate">{e}</span>
                </label>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPickerOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (selectedEmails.size === 0) {
                  toast.error("Select at least one recipient");
                  return;
                }
                startTransition(async () => { await doSend([...selectedEmails]); });
              }}
              disabled={isPending}
              className="gap-1.5"
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {selectedEmails.size > 1 ? "Send to both" : `Send to ${[...selectedEmails][0] ?? "recipient"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
