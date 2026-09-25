"use client";

import { heartbeat } from "@/server/actions/dev-session";
import { useSharedPoll } from "@/lib/use-shared-poll";

// Presence signal: ping lastSeenAt periodically so the Accounts page's
// online/offline indicator reflects real activity. One tab per browser sends
// it (see use-shared-poll.ts) — presence belongs to the person, not to each
// of the tabs they happen to have open.
export function PresenceHeartbeat({ accountId }: { accountId: string | undefined }) {
  useSharedPoll({
    key: `presence:${accountId ?? ""}`,
    enabled: !!accountId,
    fetcher: async () => {
      await heartbeat();
    },
    visibleIntervalMs: 45_000,
    hiddenIntervalMs: 45_000,
  });
  return null;
}
