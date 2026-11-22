"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { emailRevealPeriod } from "@/lib/business-time";

// A page that was rendered before the daily 13:15 Pacific reset must not keep showing a customer email that is no longer revealed. The SERVER is the authority (every render and every
// action re-reads the reveal rows for the current period; a stale request is refused), but a tab that is simply left open keeps the HTML it was given. These two helpers close
// that gap in the browser: they re-mask what the page shows the moment the period ends and ask the server for a fresh render. Neither can unmask anything - they only hide.

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * True once `resetsAt` (the ISO instant the server gave for the end of the viewer's reveal period) has passed. At that moment it also refreshes the page so the server re-renders
 * with the address masked again. Checked by a timer AND whenever the tab becomes visible or focused again (a background tab's timers are throttled, a sleeping laptop's are not run).
 * The state is tied to the specific `resetsAt` it expired for, so after a new reveal (a new `resetsAt` arrives from the server) it starts fresh.
 */
export function useRevealExpired(resetsAt: string | undefined, active: boolean): boolean {
  const router = useRouter();
  const [expiredFor, setExpiredFor] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !resetsAt) return;
    const end = Date.parse(resetsAt);
    if (!Number.isFinite(end)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      if (Date.now() < end) return false;
      setExpiredFor(resetsAt);
      router.refresh();
      return true;
    };
    const schedule = () => {
      timer = setTimeout(() => {
        if (!check()) schedule();
      }, Math.min(Math.max(end - Date.now(), 0) + 50, MAX_TIMEOUT_MS));
    };
    schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [resetsAt, active, router]);

  return expiredFor !== null && expiredFor === resetsAt;
}

/**
 * Mounted once in the CRM layout for people who are subject to masking: when the reveal period that was current at page load ends, refresh whatever page is open, so lists and
 * detail pages are re-rendered by the server (which then masks every address that is no longer revealed). Renders nothing.
 */
export function RevealResetRefresher() {
  const router = useRouter();
  const boundary = useRef<number>(0);

  useEffect(() => {
    boundary.current = emailRevealPeriod(new Date()).endsAt.getTime();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      if (Date.now() < boundary.current) return false;
      boundary.current = emailRevealPeriod(new Date()).endsAt.getTime();
      router.refresh();
      return true;
    };
    const schedule = () => {
      timer = setTimeout(() => {
        check();
        schedule();
      }, Math.min(Math.max(boundary.current - Date.now(), 0) + 50, MAX_TIMEOUT_MS));
    };
    schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [router]);

  return null;
}
