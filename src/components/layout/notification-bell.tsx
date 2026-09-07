"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Bell, CheckCheck, AlertTriangle, Clock, UserPlus, UserMinus, Eye, Mail, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchMyNotifications, markNotificationRead, markAllNotificationsRead } from "@/server/actions/notifications";
import { cn } from "@/lib/utils";

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  readAt: Date | null;
  createdAt: Date;
  task: { id: string; title: string; status: string } | null;
  lead: { id: string; contact: { firstName: string; lastName: string } } | null;
  quote: { id: string; quoteNumber: string } | null;
  contactInquiry: { id: string } | null;
};

const QUOTE_NOTIFICATION_TYPES = new Set(["QUOTE_READ", "QUOTE_VIEWED", "QUOTE_SIGNED"]);

const POLL_INTERVAL_MS = 30_000;

export function NotificationBell({ accountId }: { accountId: string | undefined }) {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    async function poll() {
      try {
        const result = await fetchMyNotifications();
        if (!cancelled) {
          setItems(result.items);
          setUnreadCount(result.unreadCount);
        }
      } catch {
        // Transient — e.g. a dev-server restart. Next interval tick retries.
      }
    }
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [accountId]);

  if (!accountId) return null;

  function openNotification(n: NotificationItem) {
    startTransition(async () => {
      if (!n.readAt) await markNotificationRead(n.id);
      if (n.task) router.push(`/tasks/${n.task.id}`);
      else if (n.quote) router.push(`/quotes/${n.quote.id}`);
      else if (n.lead) router.push(`/leads/${n.lead.id}`);
      else if (n.contactInquiry) router.push(`/get-in-touch/${n.contactInquiry.id}`);
      // NEW_SUBSCRIBER has no per-row detail page to link to — the
      // Subscriptions list itself is "the appropriate section".
      else if (n.type === "NEW_SUBSCRIBER") router.push("/subscriptions");
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          // The unread-count badge below is a purely visual overlay — a
          // screen-reader user with a static "Notifications" label would
          // get no equivalent of what a sighted user sees at a glance.
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        >
          <Bell className="h-4.5 w-4.5" />
          {unreadCount > 0 && (
            <Badge aria-hidden="true" className="absolute -top-1 -right-1 h-4.5 min-w-4.5 px-1 justify-center text-[10px] rounded-full bg-destructive text-destructive-foreground border-0">
              {unreadCount > 9 ? "9+" : unreadCount}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)] max-h-96 overflow-y-auto">
        <div className="flex items-center justify-between px-2 py-1">
          <DropdownMenuLabel className="p-0 text-xs text-muted-foreground">Notifications</DropdownMenuLabel>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 text-xs"
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault();
                startTransition(async () => {
                  await markAllNotificationsRead();
                  setItems((prev) => prev.map((i) => ({ ...i, readAt: i.readAt ?? new Date() })));
                  setUnreadCount(0);
                });
              }}
            >
              <CheckCheck className="h-3 w-3" /> Mark all read
            </Button>
          )}
        </div>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No notifications yet.</p>
        ) : (
          items.map((n) => (
            <DropdownMenuItem
              key={n.id}
              onSelect={() => openNotification(n)}
              className={cn("flex items-start gap-2 py-2 whitespace-normal", !n.readAt && "bg-primary/5")}
            >
              {n.type === "TASK_OVERDUE" ? (
                <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
              ) : n.type === "LEAD_ASSIGNED" ? (
                <UserPlus className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
              ) : n.type === "LEAD_REASSIGNED" ? (
                <UserMinus className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              ) : QUOTE_NOTIFICATION_TYPES.has(n.type) ? (
                <Eye className="h-3.5 w-3.5 text-info shrink-0 mt-0.5" />
              ) : n.type === "NEW_INQUIRY" ? (
                <Inbox className="h-3.5 w-3.5 text-info shrink-0 mt-0.5" />
              ) : n.type === "NEW_SUBSCRIBER" ? (
                <Mail className="h-3.5 w-3.5 text-success shrink-0 mt-0.5" />
              ) : (
                <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              )}
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm leading-snug", !n.readAt && "font-medium")}>{n.title}</p>
                {n.body && <p className="text-xs text-muted-foreground">{n.body}</p>}
                <p className="text-[11px] text-muted-foreground mt-0.5">{formatDistanceToNow(n.createdAt, { addSuffix: true })}</p>
              </div>
              {!n.readAt && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0 mt-1.5" />}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
