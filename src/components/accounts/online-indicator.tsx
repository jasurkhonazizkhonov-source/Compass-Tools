import { Circle, CircleOff } from "lucide-react";
import { cn } from "@/lib/utils";

const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

export function isOnline(lastSeenAt: Date | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - lastSeenAt.getTime() < ONLINE_THRESHOLD_MS;
}

export function OnlineIndicator({ lastSeenAt }: { lastSeenAt: Date | null }) {
  const online = isOnline(lastSeenAt);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", online ? "text-success" : "text-muted-foreground")}>
      {online ? <Circle className="h-2 w-2 fill-current" /> : <CircleOff className="h-2.5 w-2.5" />}
      {online ? "Online" : "Offline"}
    </span>
  );
}
