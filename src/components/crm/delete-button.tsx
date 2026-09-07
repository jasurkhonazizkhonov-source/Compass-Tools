"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shared delete-with-confirmation control for Contact/Lead/Quote/Booking.
 * Frontend-hidden per-role (the caller only renders this when the current
 * account's role passes the matching canDelete* check), but the REAL
 * authorization boundary is always the server action itself — every
 * delete action independently re-checks role + row-level visibility before
 * doing anything, so this component being rendered is never load-bearing
 * for security by itself.
 */
export function DeleteButton({
  confirmTitle,
  confirmMessage,
  deleteAction,
  redirectTo,
  label = "Delete",
  variant = "icon",
}: {
  confirmTitle: string;
  confirmMessage: string;
  deleteAction: () => Promise<void>;
  /** Where to navigate after a successful delete — omit to stay on the
   * current page (the caller's own revalidatePath calls keep it fresh). */
  redirectTo?: string;
  label?: string;
  /** "icon" for a compact icon-only button (list rows), "full" for a
   * labeled button (detail-page headers). */
  variant?: "icon" | "full";
}) {
  const [isPending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  function handleClick() {
    if (!window.confirm(`${confirmTitle}\n\n${confirmMessage}`)) return;
    setConfirming(true);
    startTransition(async () => {
      try {
        await deleteAction();
        toast.success("Deleted");
        if (redirectTo) router.push(redirectTo);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Unable to delete");
      } finally {
        setConfirming(false);
      }
    });
  }

  const busy = isPending || confirming;

  if (variant === "icon") {
    return (
      <Button size="icon-sm" variant="ghost" onClick={handleClick} disabled={busy} className="text-muted-foreground hover:text-destructive" aria-label={label}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </Button>
    );
  }

  return (
    <Button variant="outline" onClick={handleClick} disabled={busy} className="gap-2 text-destructive hover:text-destructive border-destructive/30 hover:bg-destructive/10">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
      {label}
    </Button>
  );
}
