"use client";

import { useTransition } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startGmailConnect } from "@/server/actions/gmail-connect";
import type { GmailBlock } from "@/server/actions/sequences";

const TITLE: Record<GmailBlock["problem"], string> = {
  NOT_CONNECTED: "Gmail is not connected",
  REAUTH_REQUIRED: "Gmail needs to be reconnected",
  MISSING_PERMISSION: "Gmail cannot send email",
  TEMPORARILY_UNAVAILABLE: "Gmail could not be checked",
};

/**
 * The notification shown in a Lead's Sequence section when the Gmail account that sends this lead's emails cannot be used. The message text comes from the
 * server (describeGmailProblem) and says whose Gmail it is, that nothing was sent and nobody was enrolled, and what to do. The action depends on the situation:
 *   - the viewer IS the sending agent and (re)connecting fixes it: a "Connect Gmail" button that starts the normal Gmail consent flow and brings them back to
 *     THIS lead afterwards;
 *   - someone else's Gmail needs connecting: no button (it can only be connected from that person's own account) - the message names them;
 *   - a temporary problem: NO "connect Gmail" advice, just "Check again".
 */
export function GmailProblemNotice({ gmail, message, leadId, onCheckAgain, checking }: { gmail: GmailBlock; message: string; leadId: string | null; onCheckAgain?: () => void; checking?: boolean }) {
  const [pending, startTransition] = useTransition();
  const canConnect = gmail.needsReconnect && gmail.senderIsViewer;
  return (
    <div role="alert" data-testid="gmail-problem" data-problem={gmail.problem} className="space-y-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2.5 text-sm">
      <p className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {TITLE[gmail.problem]}
      </p>
      <p className="text-muted-foreground">{message}</p>
      <div className="flex flex-wrap items-center gap-2">
        {canConnect && (
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await (leadId ? startGmailConnect(`/leads/${leadId}`) : startGmailConnect()); // redirects to Google's consent screen, then back to this lead
              })
            }
            className="gap-1.5"
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {gmail.problem === "NOT_CONNECTED" ? "Connect Gmail" : "Reconnect Gmail"}
          </Button>
        )}
        {onCheckAgain && (
          <Button type="button" size="sm" variant="outline" disabled={checking} onClick={onCheckAgain} className="gap-1.5">
            {checking && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Check again
          </Button>
        )}
      </div>
    </div>
  );
}
