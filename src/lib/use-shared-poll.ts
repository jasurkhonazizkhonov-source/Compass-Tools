"use client";

import { useEffect, useRef } from "react";

// ONE poller per browser per data source, however many CRM tabs are open.
//
// Every CRM tab used to run its own set of pollers (lead offer every 3s,
// notifications every 30s, presence every 45s). Each poll is a Server
// Action that costs several database round trips, so a user with ten tabs
// open generated ~6 statements/second in the background — enough, on this
// app's high-latency database link, to keep the connection pool saturated
// and starve real page loads ("This page couldn't load"). Tabs of the same
// browser can coordinate: the Web Locks API elects exactly one leader tab
// per key, and the leader shares each result with the others over a
// BroadcastChannel. Total polling load is now independent of tab count.
//
// - The most recently VISIBLE tab leads (a tab that becomes visible takes
//   the lock), so the tab the user is actually looking at is polled at the
//   fast, foreground rate; a hidden leader only ever runs the slow rate.
// - If the leader tab closes or crashes the browser releases its lock and
//   the next waiting tab takes over automatically.
// - Browsers without Web Locks/BroadcastChannel fall back to the previous
//   behaviour (each tab polls for itself) — never worse than before.

export type SharedPollOptions<T> = {
  /** Identifies the data source; tabs sharing a key share one poller. Include the account id. */
  key: string;
  enabled: boolean;
  fetcher: () => Promise<T>;
  /** Called in every tab with each result (own fetch or another tab's). */
  onData?: (value: T) => void;
  visibleIntervalMs: number;
  hiddenIntervalMs: number;
};

type LocksApi = {
  request: (name: string, options: { mode?: "exclusive"; steal?: boolean; signal?: AbortSignal }, callback: () => Promise<void>) => Promise<unknown>;
};

const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

export function useSharedPoll<T>({ key, enabled, fetcher, onData, visibleIntervalMs, hiddenIntervalMs }: SharedPollOptions<T>): void {
  const fetcherRef = useRef(fetcher);
  const onDataRef = useRef(onData);
  useEffect(() => {
    fetcherRef.current = fetcher;
    onDataRef.current = onData;
  });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const locks = (typeof navigator !== "undefined" ? (navigator as unknown as { locks?: LocksApi }).locks : undefined) ?? null;
    const channel = locks && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(`compass-poll:${key}`) : null;
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        if (!disposed) onDataRef.current?.((event.data as { value: T }).value);
      };
    }

    async function pollOnce(share: boolean) {
      try {
        const value = await fetcherRef.current();
        if (disposed) return;
        onDataRef.current?.(value);
        if (share) channel?.postMessage({ value });
      } catch {
        // Transient (a dev restart, a dropped connection) — next tick retries.
      }
    }

    // One leadership tenure: polls now, then on the foreground/background
    // cadence, until told to stop. `wake("poll")` cuts the current sleep short
    // and polls immediately (the tab just became visible); `wake("rearm")`
    // restarts the sleep at the current rate WITHOUT polling (the tab just
    // became hidden — it must slow down, not fire an extra request).
    type Wake = "poll" | "rearm";
    function makeLoop() {
      const state: { stop: boolean; wake: (mode?: Wake) => void } = { stop: false, wake: () => {} };
      const done = (async () => {
        let skipPoll = false;
        while (!state.stop && !disposed) {
          if (!skipPoll) await pollOnce(true);
          skipPoll = false;
          if (state.stop || disposed) break;
          const reason = await new Promise<Wake | "timeout">((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), isHidden() ? hiddenIntervalMs : visibleIntervalMs);
            state.wake = (mode: Wake = "poll") => {
              clearTimeout(timer);
              resolve(mode);
            };
          });
          if (reason === "rearm") skipPoll = true;
        }
      })();
      return { state, done };
    }

    let currentLoop: ReturnType<typeof makeLoop> | null = null;
    let pendingWait: AbortController | null = null;

    function requestLeadership(steal: boolean) {
      if (disposed || !locks) return;
      if (steal) {
        pendingWait?.abort();
        pendingWait = null;
      }
      const wait = steal ? null : new AbortController();
      if (wait) pendingWait = wait;
      // The loop THIS request started (if it is ever granted the lock).
      // Rejection handling below must only ever touch that loop: aborting an
      // old waiting request rejects asynchronously, possibly after a newer
      // request has already become leader and set currentLoop.
      let myLoop: ReturnType<typeof makeLoop> | null = null;
      const request = locks.request(
        `compass-poll:${key}`,
        // steal cannot be combined with a signal (Web Locks spec).
        steal ? { mode: "exclusive", steal: true } : { mode: "exclusive", signal: wait!.signal },
        async () => {
          if (disposed) return;
          myLoop = makeLoop();
          currentLoop = myLoop;
          await myLoop.done;
        }
      );
      request.catch(() => {
        if (!myLoop) return; // an aborted wait — never led, nothing to undo
        // We led and were stolen from by another (visible) tab: stop our
        // loop and queue up again behind the new leader.
        myLoop.state.stop = true;
        myLoop.state.wake();
        if (currentLoop === myLoop) currentLoop = null;
        if (!disposed) requestLeadership(false);
      });
    }

    function handleVisibility() {
      if (isHidden()) {
        currentLoop?.state.wake("rearm"); // leading in the background: slow down, don't poll
        return;
      }
      if (currentLoop) currentLoop.state.wake("poll"); // already leading: poll now, re-arm at the fast rate
      else requestLeadership(true); // not leading: this is the tab being looked at — take over
    }

    if (locks) {
      // A tab that opens in the foreground leads immediately; a background
      // tab waits its turn but still fetches once so it has data to show.
      if (isHidden()) {
        void pollOnce(false);
        requestLeadership(false);
      } else {
        requestLeadership(true);
      }
      document.addEventListener("visibilitychange", handleVisibility);
    } else {
      // Fallback: independent per-tab polling (the previous behaviour).
      const loop = makeLoop();
      currentLoop = loop;
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      pendingWait?.abort();
      if (currentLoop) {
        currentLoop.state.stop = true;
        currentLoop.state.wake();
      }
      channel?.close();
    };
  }, [key, enabled, visibleIntervalMs, hiddenIntervalMs]);
}
