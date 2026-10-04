"use client";

import { format } from "date-fns";
import { MessageSquareText, CheckCircle2 } from "lucide-react";
import { EmailComposerButton } from "@/components/crm/email-composer-dialog";
import { unsubscribeReasonLabel } from "@/lib/unsubscribe-reasons";

export type UnsubscribedSubscriber = {
  id: string;
  email: string;
  unsubscribedAt: Date | null;
  unsubscribeReasonCategory: string | null;
  unsubscribeReason: string | null;
  unsubscribeSource: string | null;
  unsubscribeRespondedAt: Date | null;
  lastCampaignName: string | null;
};

const SOURCE_LABEL: Record<string, string> = { EMAIL_LINK: "Unsubscribe link in an email" };

/** What the customer told us — shown as plain text (React escapes it), never as HTML. */
function ReasonBlock({ category, text }: { category: string | null; text: string | null }) {
  const label = unsubscribeReasonLabel(category);
  if (!label && !text) return <p className="text-sm italic text-muted-foreground">No reason provided</p>;
  return (
    <div className="space-y-1">
      {label && <p className="text-sm font-medium">{label}</p>}
      {text && <p className="whitespace-pre-wrap break-words rounded-md border-l-2 bg-muted/40 px-2.5 py-1.5 text-sm">{text}</p>}
    </div>
  );
}

/**
 * The unsubscribe details of one subscriber for marketing staff: when, via what, after
 * which campaign, the customer's reason (or "No reason provided") and a Respond button.
 * Respond opens the standard one-to-one composer (the same Gmail send as Lead/Contact
 * email) with a professional, editable subject and the customer's reason shown read-only
 * above the message — it is never pasted into the message for the agent. Responding
 * does not change the subscription.
 */
export function UnsubscribeDetails({ subscriber }: { subscriber: UnsubscribedSubscriber }) {
  const sourceLabel = subscriber.unsubscribeSource ? (SOURCE_LABEL[subscriber.unsubscribeSource] ?? subscriber.unsubscribeSource) : null;
  return (
    <div className="max-w-md min-w-[16rem] space-y-2" data-testid="unsubscribe-details">
      <dl className="space-y-0.5 text-xs text-muted-foreground">
        {subscriber.unsubscribedAt && (
          <div>
            <dt className="inline">Unsubscribed: </dt>
            <dd className="inline text-foreground">{format(subscriber.unsubscribedAt, "MMM d, yyyy 'at' h:mm a")}</dd>
          </div>
        )}
        <div>
          <dt className="inline">Source: </dt>
          <dd className="inline text-foreground">{sourceLabel ?? "Not recorded"}</dd>
        </div>
        {subscriber.lastCampaignName && (
          <div>
            <dt className="inline">Last campaign received: </dt>
            <dd className="inline break-words text-foreground">{subscriber.lastCampaignName}</dd>
          </div>
        )}
      </dl>
      <div>
        <p className="mb-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Unsubscribe Reason</p>
        <ReasonBlock category={subscriber.unsubscribeReasonCategory} text={subscriber.unsubscribeReason} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <EmailComposerButton
          subscriberId={subscriber.id}
          emails={[subscriber.email]}
          contactName={subscriber.email}
          triggerLabel="Respond"
          defaultSubject="Regarding your email preferences"
          context={
            <div className="rounded-md border bg-muted/30 p-3" data-testid="respond-context">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <MessageSquareText className="h-3.5 w-3.5" /> What the customer told us (private — not included in your message)
              </p>
              <ReasonBlock category={subscriber.unsubscribeReasonCategory} text={subscriber.unsubscribeReason} />
              <p className="mt-2 text-[11px] text-muted-foreground">This is a personal reply. It does not re-subscribe the customer, and no unsubscribe footer is added.</p>
            </div>
          }
        />
        {subscriber.unsubscribeRespondedAt && (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" /> Responded {format(subscriber.unsubscribeRespondedAt, "MMM d, yyyy")}
          </span>
        )}
      </div>
    </div>
  );
}
