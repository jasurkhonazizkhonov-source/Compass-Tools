"use client";

import { useEffect } from "react";
import { heartbeat } from "@/server/actions/dev-session";

// Dev-mode presence signal: while a dev-session account is "acting as" the
// current user, ping lastSeenAt periodically so the Accounts page's
// online/offline indicator reflects real activity. This is a placeholder
// for real presence (authenticated sessions + websockets/heartbeat) once
// auth lands — same field, same UI, different data source.
export function PresenceHeartbeat({ accountId }: { accountId: string | undefined }) {
  useEffect(() => {
    if (!accountId) return;
    heartbeat();
    const interval = setInterval(() => heartbeat(), 45_000);
    return () => clearInterval(interval);
  }, [accountId]);

  return null;
}
