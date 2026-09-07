"use client";

import { useTransition } from "react";
import { LogOut, UserCircle2, Mail, MailCheck, MailWarning } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ROLE_LABELS } from "@/lib/permissions";
import { initials } from "@/lib/account-format";
import { signOut } from "@/server/actions/dev-session";
import { startGmailConnect, disconnectGmail } from "@/server/actions/gmail-connect";
import type { AccountRole } from "@/generated/prisma/client";
import type { GmailConnectionState } from "@/server/queries/gmail-connection";

type AccountOption = { id: string; fullName: string; email: string; role: AccountRole };

/**
 * Read-only account identity + Sign Out — replaces the old
 * DevAccountSwitcher, which let anyone become any account with one click.
 * There is no account-switching affordance here at all: the only way to
 * act as a different account is to sign out and sign back in with that
 * account's own Google identity.
 *
 * Also surfaces Gmail-connection status — a SEPARATE authorization from
 * Google Sign-In (see gmail-oauth-config.ts's file comment): being signed
 * into the CRM never implies the CRM can send email as this person.
 */
export function AccountMenu({ current, gmailStatus }: { current: AccountOption | null; gmailStatus: GmailConnectionState }) {
  const [isPending, startTransition] = useTransition();

  function handleSignOut() {
    startTransition(async () => {
      // signOut() invalidates the session server-side (clears
      // Account.activeSessionId) and clears the cookie, then redirects —
      // a real invalidation, not just forgetting the cookie client-side.
      await signOut();
    });
  }

  function handleConnectGmail() {
    startTransition(async () => {
      await startGmailConnect(); // redirects to Google's consent screen
    });
  }

  function handleDisconnectGmail() {
    startTransition(async () => {
      await disconnectGmail();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="gap-2 px-2 h-9"
          disabled={isPending}
          // Explicit and breakpoint-independent: the name/role text below
          // is visually hidden below `lg` (display:none, which also drops
          // it from the accessibility tree), so without this the button's
          // accessible name would silently shrink to just the avatar's
          // initials at every narrower width — a real assistive-technology
          // regression, not merely a visual one.
          aria-label={current ? `Account menu for ${current.fullName}, ${ROLE_LABELS[current.role]}` : "Account menu"}
        >
          <Avatar className="h-6 w-6">
            <AvatarFallback className="text-[10px] bg-primary text-primary-foreground">
              {current ? initials(current.fullName) : <UserCircle2 className="h-4 w-4" />}
            </AvatarFallback>
          </Avatar>
          {/* `lg`, not `sm` — see pacific-clock.tsx's comment on the same
              768px overflow: the topbar's right-side group (this text plus
              the clock, lead-queue label, notification bell, theme toggle)
              needs the full 640-1023px range as icon/avatar-only to fit
              once the sidebar switches to its fixed desktop width at 768px.
              The account menu itself (the button, the dropdown, sign-out)
              is completely unaffected — only this label's visibility
              changed. */}
          <div className="hidden lg:flex flex-col items-start leading-none">
            <span className="text-xs font-medium">{current?.fullName ?? "Account"}</span>
            <span className="text-[10px] text-muted-foreground">{current ? ROLE_LABELS[current.role] : ""}</span>
          </div>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{current?.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />

        {gmailStatus === "CONNECTED" ? (
          <>
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-foreground">
              <MailCheck className="h-3.5 w-3.5 text-success" />
              Gmail Connected
            </div>
            <DropdownMenuItem onSelect={handleDisconnectGmail} className="gap-2 text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              Disconnect Gmail
            </DropdownMenuItem>
          </>
        ) : gmailStatus === "REVOKED" ? (
          <DropdownMenuItem onSelect={handleConnectGmail} className="gap-2 text-amber-600 focus:text-amber-600">
            <MailWarning className="h-3.5 w-3.5" />
            Reconnect Gmail
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={handleConnectGmail} className="gap-2">
            <Mail className="h-3.5 w-3.5" />
            Connect Gmail
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleSignOut} className="gap-2 text-destructive focus:text-destructive">
          <LogOut className="h-3.5 w-3.5" />
          Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
