"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";

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
  confirmLabel = "Delete",
  deleteAction,
  redirectTo,
  label = "Delete",
  variant = "icon",
}: {
  confirmTitle: string;
  confirmMessage: string;
  /** The confirm button's own text — say what it does ("Delete lead"), never "OK". */
  confirmLabel?: string;
  deleteAction: () => Promise<void>;
  /** Where to navigate after a successful delete — omit to stay on the
   * current page (the caller's own revalidatePath calls keep it fresh). */
  redirectTo?: string;
  label?: string;
  /** "icon" for a compact icon-only button (list rows), "full" for a
   * labeled button (detail-page headers). */
  variant?: "icon" | "full";
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // The ConfirmDialog owns the pending / error / double-click handling. A failed delete keeps the dialog open with the reason;
  // success closes it, confirms with a toast and (optionally) navigates away.
  async function runDelete() {
    await deleteAction();
    toast.success("Deleted");
    if (redirectTo) router.push(redirectTo);
  }

  const dialog = (
    <ConfirmDialog open={open} onOpenChange={setOpen} title={confirmTitle} description={confirmMessage} confirmLabel={confirmLabel} onConfirm={runDelete} />
  );

  if (variant === "icon") {
    return (
      <>
        <Button size="icon-sm" variant="ghost" onClick={() => setOpen(true)} className="text-muted-foreground hover:text-destructive" aria-label={label}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        {dialog}
      </>
    );
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} className="gap-2 text-destructive hover:text-destructive border-destructive/30 hover:bg-destructive/10">
        <Trash2 className="h-4 w-4" />
        {label}
      </Button>
      {dialog}
    </>
  );
}
