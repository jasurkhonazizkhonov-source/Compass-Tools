"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { unenrollLead } from "@/server/actions/sequences";

/**
 * Stops ONE active sequence enrollment for the lead being viewed. The confirmation is the CRM's own ConfirmDialog (never a browser confirm); the
 * server action re-checks authorization, that the enrollment belongs to this lead and that it is still active, so hiding or showing this button
 * is a convenience, not the security boundary. A problem (already stopped, not allowed) keeps the dialog open and is shown in it.
 */
export function UnenrollSequenceButton({ enrollmentId, leadId, sequenceName, failed = false }: { enrollmentId: string; leadId: string; sequenceName: string; failed?: boolean }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} aria-label={`Unenroll from ${sequenceName}`}>
        Unenroll
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Unenroll this lead?"
        description={
          <>
            {failed ? (
              <>
                <strong>{sequenceName}</strong> has stopped for this lead. Unenrolling ends it for good: the remaining steps are cancelled and nothing more can be sent through it. Emails that
                were already sent stay in the history, and the lead can be enrolled again later.
              </>
            ) : (
              <>
                This lead will stop receiving the automated emails from <strong>{sequenceName}</strong>. Emails that were already sent stay in the history, and the lead can be enrolled again
                later.
              </>
            )}
          </>
        }
        confirmLabel="Unenroll"
        onConfirm={async () => {
          const result = await unenrollLead(enrollmentId, leadId);
          if (!result.ok) return { error: result.error ?? "Could not unenroll this lead." };
          toast.success("Lead unenrolled");
          router.refresh();
        }}
      />
    </>
  );
}
