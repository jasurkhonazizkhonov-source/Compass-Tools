"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { deleteInquiry } from "@/server/actions/contact-inquiries";

/** Part 3 — Admin-only, same ConfirmDialog pattern as SequenceDeleteButton.
 * Page-level admin gating already prevents any other role from ever
 * rendering this at all; the server action re-asserts admin independently. */
export function InquiryDeleteButton({ inquiryId, name, redirectTo }: { inquiryId: string; name: string; redirectTo?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Delete inquiry"
        aria-label="Delete inquiry"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(true); }}
      >
        <Trash2 className="h-3.5 w-3.5 text-destructive" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this inquiry?"
        description={`"${name}"'s Get in Touch submission will be permanently deleted, including any internal notes. This action cannot be undone.`}
        confirmLabel="Delete Inquiry"
        onConfirm={async () => {
          try {
            await deleteInquiry(inquiryId);
            toast.success("Inquiry deleted");
            if (redirectTo) router.push(redirectTo);
            else router.refresh();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to delete inquiry");
          }
        }}
      />
    </>
  );
}
