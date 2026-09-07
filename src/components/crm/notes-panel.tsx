"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { StickyNote, Send, Pencil, Trash2, Loader2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/crm/empty-state";
import { addNote, updateNote, deleteNote } from "@/server/actions/leads";

type NoteRow = {
  id: string;
  body: string;
  createdAt: Date;
  author: { fullName: string } | null;
};

export function NotesPanel({
  contactId,
  leadId,
  notes,
}: {
  contactId?: string;
  leadId?: string;
  notes: NoteRow[];
}) {
  const [draft, setDraft] = useState("");
  const [isPending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");

  function submit() {
    if (!draft.trim()) return;
    startTransition(async () => {
      try {
        await addNote({ contactId, leadId, body: draft.trim() });
        setDraft("");
      } catch {
        toast.error("Failed to add note");
      }
    });
  }

  function saveEdit(id: string) {
    startTransition(async () => {
      try {
        await updateNote(id, editBody, { contactId, leadId });
        setEditingId(null);
      } catch {
        toast.error("Failed to update note");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note..."
          rows={2}
          className="flex-1"
        />
        <Button size="icon" onClick={submit} disabled={isPending || !draft.trim()} aria-label="Add note">
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>

      {notes.length === 0 ? (
        <EmptyState icon={StickyNote} title="No notes yet" description="Notes you add will appear here with author and timestamp." />
      ) : (
        <ul className="space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="group rounded-md border p-3">
              {editingId === n.id ? (
                <div className="space-y-2">
                  <Textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={2} autoFocus />
                  <div className="flex gap-1.5 justify-end">
                    <Button size="icon-sm" onClick={() => saveEdit(n.id)} aria-label="Save note"><Check className="h-3.5 w-3.5" /></Button>
                    <Button size="icon-sm" variant="outline" onClick={() => setEditingId(null)} aria-label="Cancel editing note"><X className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm whitespace-pre-wrap">{n.body}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      {n.author?.fullName ?? "Unknown"} · {formatDistanceToNow(n.createdAt, { addSuffix: true })}
                    </p>
                    <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Edit note"
                        onClick={() => {
                          setEditingId(n.id);
                          setEditBody(n.body);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete note"
                        onClick={() => startTransition(() => deleteNote(n.id, { contactId, leadId }))}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
