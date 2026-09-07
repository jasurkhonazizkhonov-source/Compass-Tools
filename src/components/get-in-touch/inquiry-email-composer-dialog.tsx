"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Mail, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { sendInquiryEmail } from "@/server/actions/contact-inquiries";

/**
 * Item 9 — the Get in Touch detail page's Email button, replacing the old
 * plain `mailto:` link with an internal CRM composer sent through the
 * admin's own connected Gmail (see sendInquiryEmail) — modeled directly on
 * the Leads page's own EmailComposerButton (email-composer-dialog.tsx),
 * simplified since a ContactInquiry has exactly one email address: the
 * recipient is always shown as a disabled, non-editable field (never a
 * free-text/editable "To"), and the actual send is re-derived server-side
 * from the inquiry row regardless of what this component displays — so
 * this dialog can never be used to send to a different inquiry's address.
 */
export function InquiryEmailComposerButton({
  inquiryId,
  email,
  contactName,
}: {
  inquiryId: string;
  email: string;
  contactName: string;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isPending, startTransition] = useTransition();

  function reset() {
    setSubject("");
    setBody("");
  }

  function send() {
    if (!subject.trim() || !body.trim()) {
      toast.error("Subject and message are both required");
      return;
    }
    startTransition(async () => {
      try {
        await sendInquiryEmail(inquiryId, { subject: subject.trim(), body: body.trim() });
        toast.success("Email sent");
        setOpen(false);
        reset();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send email");
      }
    });
  }

  return (
    <>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Mail className="h-3.5 w-3.5" /> Email
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
              <Input value={email} disabled />
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
