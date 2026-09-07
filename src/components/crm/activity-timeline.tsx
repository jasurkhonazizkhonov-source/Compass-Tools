"use client";

import { useState, useTransition } from "react";
import { format, isToday, isYesterday } from "date-fns";
import {
  Activity,
  UserPlus,
  ArrowRightLeft,
  Inbox,
  RefreshCw,
  Pencil,
  StickyNote,
  Mail,
  CreditCard,
  FileText,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { EmptyState } from "@/components/crm/empty-state";
import { Button } from "@/components/ui/button";
import { loadMoreActivities } from "@/server/actions/activity";

type ActivityRow = {
  id: string;
  type: string;
  description: string;
  createdAt: Date;
  actor: { fullName: string } | null;
};

// Prefix/substring matching rather than an exhaustive per-string map — new
// event types (e.g. a future PAYMENT_* variant) fall through to the
// generic Activity icon automatically instead of needing this list
// updated in lockstep every time a new `logActivity` call site is added
// elsewhere in the app.
function iconFor(type: string): LucideIcon {
  if (type.includes("CREATED")) return UserPlus;
  if (type.includes("RECEIVED_FROM_QUEUE")) return Inbox;
  if (type.includes("REASSIGNED") || type.includes("AUTO_ASSIGNED")) return ArrowRightLeft;
  if (type.includes("STATUS_CHANGED")) return RefreshCw;
  if (type.includes("NOTE")) return StickyNote;
  if (type.includes("EMAIL_SENT")) return Mail;
  if (type.includes("PAYMENT")) return CreditCard;
  if (type.includes("QUOTE")) return FileText;
  if (type.includes("UPDATED") || type.includes("ADDED")) return Pencil;
  return Activity;
}

// "Today" / "Yesterday" / full weekday name (recent) / full date (older) —
// matches the task's own mockup grouping without needing a "this week"
// special case beyond what date-fns already gives cheaply.
function dayLabel(date: Date): string {
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  const daysAgo = (Date.now() - date.getTime()) / 86_400_000;
  return daysAgo < 7 ? format(date, "EEEE") : format(date, "MMM d, yyyy");
}

const INITIAL_PAGE_SIZE = 30;

/**
 * `leadId`/`contactId` (exactly one, matching whichever detail page this
 * renders on) enable "Load more" — the initial `activities` page comes from
 * the owning page's own query (getLeadDetail/getContactDetail, still capped
 * at 30 for a fast page load), and older history beyond that is fetched
 * on demand via loadMoreActivities' own cursor pagination, never loaded
 * upfront. Omit both to render a fixed, non-paginated list (matches every
 * existing caller's behavior when a record has fewer than 30 events, since
 * there's nothing more to load).
 */
export function ActivityTimeline({
  activities: initialActivities,
  leadId,
  contactId,
}: {
  activities: ActivityRow[];
  leadId?: string;
  contactId?: string;
}) {
  const [activities, setActivities] = useState(initialActivities);
  // A full first page (exactly INITIAL_PAGE_SIZE rows) is the signal there
  // MIGHT be more — avoids a separate COUNT query just to know upfront,
  // matching this app's existing "true count only when it's cheap" bias.
  // loadMoreActivities' own `hasMore` flag takes over as the source of
  // truth once a page has actually been fetched.
  const [hasMore, setHasMore] = useState(initialActivities.length === INITIAL_PAGE_SIZE);
  const [isPending, startTransition] = useTransition();

  function loadMore() {
    const cursor = activities[activities.length - 1]?.id;
    if (!cursor) return;
    startTransition(async () => {
      try {
        const result = await loadMoreActivities({ leadId, contactId, cursor });
        setActivities((prev) => [...prev, ...result.activities]);
        setHasMore(result.hasMore);
      } catch {
        // Older history failing to load is never worse than what's already
        // shown — leave the visible list exactly as it was rather than
        // clearing it or throwing a hard error over a "load more" click.
        setHasMore(false);
      }
    });
  }

  if (activities.length === 0) {
    return <EmptyState icon={Activity} title="No activity yet" description="Actions taken on this record will appear here." />;
  }

  // Activities already arrive newest-first (ordered by the query); group
  // consecutive same-day entries under one date heading without
  // re-sorting — a stable grouping pass, not a second sort.
  const groups: { label: string; items: ActivityRow[] }[] = [];
  for (const a of activities) {
    const label = dayLabel(a.createdAt);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.label === label) {
      lastGroup.items.push(a);
    } else {
      groups.push({ label, items: [a] });
    }
  }

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="text-xs font-semibold text-muted-foreground mb-2">{group.label}</p>
          <ol className="relative border-l border-border pl-4 space-y-4">
            {group.items.map((a) => {
              const Icon = iconFor(a.type);
              return (
                <li key={a.id} className="relative">
                  <span className="absolute -left-[25px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary/15 ring-4 ring-background">
                    <Icon className="h-2.5 w-2.5 text-primary" />
                  </span>
                  <p className="text-sm">{a.description}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {a.actor?.fullName ?? "System"} · {format(a.createdAt, "h:mm a")}
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      {hasMore && (leadId || contactId) && (
        <div className="flex justify-center pt-1">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={isPending} className="gap-1.5">
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
