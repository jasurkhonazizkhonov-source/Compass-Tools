"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { safeActionMessage } from "@/lib/safe-action-message";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The one confirmation dialog for the whole CRM — it replaces every browser window.confirm / alert / prompt.
 *
 * - `role="alertdialog"` with a title and description wired up for assistive technology; focus is trapped inside while it is
 *   open, Escape and Cancel close it, and focus returns to the control that opened it (DialogContent's
 *   useReturnFocus — Radix only does this for a <DialogTrigger>, and these dialogs are opened from handlers).
 * - Focus starts on Cancel, so a stray Enter / Space never fires the destructive action.
 * - While the action runs the dialog cannot be dismissed (Escape, overlay click, the close button and Cancel are all inert),
 *   both buttons are disabled and the confirm button shows a spinner. A second click while pending is ignored.
 * - If the action reports a problem — by throwing, or by returning `{ error: "..." }` (server actions in production return
 *   their errors, they do not throw) — the dialog STAYS open and shows the message so nothing looks like it succeeded.
 * - `variant="destructive"` (default) styles the primary button as destructive; use "default" for non-destructive confirmations.
 *   Always pass a specific `confirmLabel` ("Delete lead", "Remove segment") — never a bare "OK".
 */
export type ConfirmResult = void | { error?: string | null } | null | undefined;

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  variant = "destructive",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "destructive" | "default";
  onConfirm: () => Promise<ConfirmResult> | ConfirmResult;
}) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: two clicks in the same tick both see the pre-render state, but only one sees the ref already set.
  const inFlight = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  function close(next: boolean) {
    if (inFlight.current) return; // cannot be dismissed mid-action
    if (!next) setError(null);
    onOpenChange(next);
  }

  async function handleConfirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsPending(true);
    setError(null);
    let succeeded = false;
    try {
      const result = await onConfirm();
      if (result && typeof result === "object" && typeof result.error === "string" && result.error.length > 0) {
        setError(result.error);
      } else {
        succeeded = true;
      }
    } catch (err) {
      // Production masks the text of a thrown server-action error, so this is a generic fallback unless the caller threw its own.
      setError(safeActionMessage(err, "Something went wrong. Nothing was changed — please try again."));
    }
    // Every outcome releases the guard, so a refusal can be retried or dismissed.
    inFlight.current = false;
    setIsPending(false);
    if (succeeded) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        role="alertdialog"
        showCloseButton={!isPending}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
        onEscapeKeyDown={(e) => {
          if (inFlight.current) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (inFlight.current) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive" data-testid="confirm-dialog-error">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={() => close(false)} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button variant={variant === "destructive" ? "destructive" : "default"} onClick={handleConfirm} disabled={isPending} aria-busy={isPending}>
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
