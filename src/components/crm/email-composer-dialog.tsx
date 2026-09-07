"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Mail, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { sendLeadEmail } from "@/server/actions/leads";
import { sendContactEmail } from "@/server/actions/contacts";

/**
 * Part 2's original Leads-page Email button, generalized (Pass 6) so the
 * Contact detail page's own Email button — next to CallButton, the same
 * way Lead's already is — can reuse the exact same composer UI and the
 * exact same underlying send path (sendCrmEmail — see that module) rather
 * than a second, parallel implementation. Which server action gets called
 * is the only thing that differs between the two callers; everything else
 * (recipient selection, validation, loading/success/error states) is
 * identical. Moved out of components/leads/ to components/crm/ since it's
 * no longer Lead-specific, matching CallButton's own location.
 *
 * Mirrors CallButton's own precedent of simply not rendering when there's
 * no contact info to act on, so a lead/contact with no email on file never
 * shows a dead-end button.
 */
export function EmailComposerButton({
  leadId,
  contactId,
  emails,
  contactName,
  size = "icon-sm",
}: {
  /** Exactly one of leadId/contactId is expected — whichever the caller
   * actually has. Both present is not a supported case; pick the one that
   * matches which detail page this is rendered on. */
  leadId?: string;
  contactId?: string;
  /** Every email address on file for this lead's/contact's own record,
   * primary first — when there's more than one, the agent explicitly picks
   * which to send to (or several) rather than silently defaulting. Always
   * re-verified server-side against the real Contact record before
   * sending — this list existing client-side is a UI convenience only,
   * never itself trusted as authorization. */
  emails: string[];
  contactName: string;
  size?: "icon-sm" | "icon";
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set(emails[0] ? [emails[0]] : []));
  const [isPending, startTransition] = useTransition();

  if (emails.length === 0) return null;

  function reset() {
    setSubject("");
    setBody("");
    setSelected(new Set(emails[0] ? [emails[0]] : []));
  }

  function toggleRecipient(addr: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }

  function send() {
    if (!subject.trim() || !body.trim()) {
      toast.error("Subject and message are both required");
      return;
    }
    if (selected.size === 0) {
      toast.error("Select at least one recipient");
      return;
    }
    startTransition(async () => {
      try {
        const payload = { to: [...selected].join(", "), subject: subject.trim(), body: body.trim() };
        if (leadId) {
          await sendLeadEmail(leadId, payload);
        } else if (contactId) {
          await sendContactEmail(contactId, payload);
        } else {
          throw new Error("No lead or contact to send this email against");
        }
        toast.success(selected.size > 1 ? "Email sent to both addresses" : "Email sent");
        setOpen(false);
        reset();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send email");
      }
    });
  }

  return (
    <>
      <Button
        variant="outline"
        size={size}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen(true);
        }}
        aria-label={`Email ${contactName}`}
        title={`Email ${contactName}`}
      >
        <Mail className="h-3.5 w-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Email {contactName}</DialogTitle>
            <DialogDescription>Sent from your connected Gmail account.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>To</Label>
              {emails.length > 1 ? (
                <div className="space-y-1 rounded-md border p-2">
                  {emails.map((addr) => (
                    <label key={addr} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted/50 cursor-pointer">
                      <Checkbox checked={selected.has(addr)} onCheckedChange={() => toggleRecipient(addr)} />
                      <span className="truncate">{addr}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <Input value={emails[0]} disabled />
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Subject *</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" disabled={isPending} autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label>Message *</Label>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message..." rows={8} disabled={isPending} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={send} disabled={isPending} className="gap-1.5">
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
