import { differenceInCalendarDays, differenceInHours, differenceInMinutes, format } from "date-fns";
import { StatusBadge } from "@/components/crm/status-badge";
import type { StatusTone } from "@/lib/status-meta";

/**
 * Always renders an explicit, human-readable label ("Due today", "2 days
 * left", "Overdue by 3 hours") rather than relying on color alone — color is
 * a reinforcing signal, not the only one.
 */
export function CountdownBadge({ dueAt, status }: { dueAt: Date | null; status: "PENDING" | "COMPLETED" }) {
  if (status === "COMPLETED") {
    return <StatusBadge label="Completed" tone="success" />;
  }
  if (!dueAt) {
    return <StatusBadge label="No due date" tone="neutral" />;
  }

  const now = new Date();
  const dayDiff = differenceInCalendarDays(dueAt, now);
  const overdue = dueAt.getTime() < now.getTime();

  let label: string;
  let tone: StatusTone;

  if (overdue) {
    const hoursAgo = differenceInHours(now, dueAt);
    const minutesAgo = differenceInMinutes(now, dueAt);
    if (hoursAgo < 1) label = `Overdue by ${Math.max(1, minutesAgo)} min`;
    else if (hoursAgo < 24) label = `Overdue by ${hoursAgo} hr${hoursAgo === 1 ? "" : "s"}`;
    else label = `Overdue by ${Math.abs(dayDiff)} day${Math.abs(dayDiff) === 1 ? "" : "s"}`;
    tone = "destructive";
  } else if (dayDiff === 0) {
    label = `Due today, ${format(dueAt, "h:mm a")}`;
    tone = "warning";
  } else if (dayDiff === 1) {
    label = "Due tomorrow";
    tone = "info";
  } else {
    label = `${dayDiff} days left`;
    tone = "neutral";
  }

  return <StatusBadge label={label} tone={tone} />;
}
