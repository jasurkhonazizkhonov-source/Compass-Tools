"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { cancelCampaignRecipient } from "@/server/actions/campaign-delivery";

/**
 * Cancel ONE recipient that has not been sent yet. Offered only for such recipients, but the button is only a convenience: the server action re-checks, atomically, that the recipient
 * is still waiting (and says plainly if the worker had already started on it - it never reports a cancellation that did not happen). The rest of the campaign is untouched.
 */
export function CancelRecipientButton({ campaignId, sendId, label }: { campaignId: string; sendId: string; /** the (possibly masked) address, for the accessible name only */ label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
        aria-label={`Cancel sending to ${label}`}
        onClick={() => setOpen(true)}
      >
        <Ban className="h-3 w-3" aria-hidden /> Cancel
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Cancel this recipient?"
        description="This one message will not be sent. The rest of the campaign continues. This cannot be undone."
        cancelLabel="Keep"
        confirmLabel="Cancel recipient"
        onConfirm={async () => {
          try {
            const r = await cancelCampaignRecipient(campaignId, sendId);
            if (!r.ok) {
              router.refresh(); // the list may be out of date (that is often why it could not be cancelled)
              return { error: r.error };
            }
            toast.success("Recipient cancelled");
            router.refresh();
          } catch {
            return { error: "That could not be done right now." };
          }
        }}
      />
    </>
  );
}
