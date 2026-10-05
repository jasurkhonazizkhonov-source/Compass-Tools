"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/crm/confirm-dialog";
import { signOutAllUsers } from "@/server/actions/session-admin";

/**
 * Administrator-only emergency control: ends every active CRM session in the company, the Administrator's own included. The
 * server action re-checks the role and requires a recent sign-in; this button being visible authorizes nothing. On success the
 * action redirects to the sign-in page (this session is among those ended), so the dialog only ever has to show a refusal.
 */
export function SignOutAllUsersButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} className="gap-1.5 text-destructive hover:text-destructive border-destructive/30 hover:bg-destructive/10">
        <LogOut className="h-4 w-4" />
        Sign out all users
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Sign out all users?"
        description="Every signed-in user, including you, is signed out immediately and sent to the sign-in page. They can sign in again right away. Nothing else changes: no account, lead, quote or booking is affected."
        confirmLabel="Sign out all users"
        onConfirm={async () => {
          const result = await signOutAllUsers();
          return result;
        }}
      />
    </>
  );
}
