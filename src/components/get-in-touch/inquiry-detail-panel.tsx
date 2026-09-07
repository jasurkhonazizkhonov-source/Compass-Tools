"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Phone, MessageSquare, Loader2, Send, StickyNote } from "lucide-react";
import { InquiryEmailComposerButton } from "@/components/get-in-touch/inquiry-email-composer-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/crm/status-badge";
import { EmptyState } from "@/components/crm/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Check } from "lucide-react";
import { INQUIRY_STATUS_META, INQUIRY_STATUS_ORDER } from "@/lib/status-meta";
import { markInquiryRead, updateInquiryStatus, addInquiryNote } from "@/server/actions/contact-inquiries";
import { cn } from "@/lib/utils";
import type { InquiryStatus } from "@/generated/prisma/client";

type InquiryNoteRow = { id: string; body: string; createdAt: Date; author: { fullName: string } | null };

export function InquiryDetailPanel({
  inquiryId,
  status,
  readAt,
  email,
  phone,
  notes,
  contactName,
}: {
  inquiryId: string;
  status: InquiryStatus;
  readAt: Date | null;
  email: string;
  phone: string | null;
  notes: InquiryNoteRow[];
  contactName: string;
}) {
  const [currentStatus, setCurrentStatus] = useState(status);
  const [draft, setDraft] = useState("");
  const [isPending, startTransition] = useTransition();
  const markedRef = useRef(false);

  // Mark-read fires once, on view — matches the "mark read" requirement
  // without needing an explicit button for the common case.
  useEffect(() => {
    if (readAt || markedRef.current) return;
    markedRef.current = true;
    markInquiryRead(inquiryId).catch(() => undefined);
  }, [inquiryId, readAt]);

  function handleStatusChange(next: InquiryStatus) {
    if (next === currentStatus) return;
    setCurrentStatus(next);
    startTransition(async () => {
      try {
        await updateInquiryStatus(inquiryId, next);
        toast.success(`Status updated to ${INQUIRY_STATUS_META[next].label}`);
      } catch {
        toast.error("Failed to update status");
      }
    });
  }

  function submitNote() {
    if (!draft.trim()) return;
    startTransition(async () => {
      try {
        await addInquiryNote(inquiryId, draft.trim());
        setDraft("");
      } catch {
        toast.error("Failed to add note");
      }
    });
  }

  const meta = INQUIRY_STATUS_META[currentStatus];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" asChild className="gap-1.5">
          <a href={`tel:${phone?.replace(/[^+\d]/g, "") ?? ""}`} aria-disabled={!phone}>
            <Phone className="h-3.5 w-3.5" /> Call
          </a>
        </Button>
        <InquiryEmailComposerButton inquiryId={inquiryId} email={email} contactName={contactName} />
        {phone && (
          <Button variant="outline" size="sm" asChild className="gap-1.5">
            <a href={`sms:${phone.replace(/[^+\d]/g, "")}`}>
              <MessageSquare className="h-3.5 w-3.5" /> Message
            </a>
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={isPending}>
            <button className="ml-auto inline-flex items-center gap-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
              {isPending ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Updating...
                </span>
              ) : (
                <StatusBadge label={meta.label} tone={meta.tone} className="cursor-pointer hover:opacity-80" />
              )}
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {INQUIRY_STATUS_ORDER.map((s) => {
              const m = INQUIRY_STATUS_META[s];
              return (
                <DropdownMenuItem key={s} onSelect={() => handleStatusChange(s)} className="gap-2">
                  <span className={cn("h-2 w-2 rounded-full")} />
                  <span className="flex-1">{m.label}</span>
                  {s === currentStatus && <Check className="h-3.5 w-3.5" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Internal Notes</p>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a note..." rows={2} className="flex-1" />
            <Button size="icon" onClick={submitNote} disabled={isPending || !draft.trim()} aria-label="Add note">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          {notes.length === 0 ? (
            <EmptyState icon={StickyNote} title="No notes yet" description="Notes you add will appear here with author and timestamp." />
          ) : (
            <ul className="space-y-2">
              {notes.map((n) => (
                <li key={n.id} className="rounded-md border p-3">
                  <p className="text-sm whitespace-pre-wrap">{n.body}</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {n.author?.fullName ?? "Unknown"} · {formatDistanceToNow(n.createdAt, { addSuffix: true })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
