"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";

// Intl.DateTimeFormat with an explicit IANA zone handles PST/PDT
// transitions correctly on its own — no manual UTC-offset math, which
// would silently drift wrong twice a year around daylight saving changes.
const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function PacificClock() {
  // No server-rendered value at all — both the server and the client's
  // very first render show nothing (mounted=false), avoiding a hydration
  // mismatch, since the clock is inherently a client-local "right now"
  // value with nothing meaningful to render server-side anyway. The tick
  // counter only forces periodic re-renders; the actual time is read fresh
  // from Date.now() directly in the render body each time (same pattern as
  // the lead-offer countdown), so there's never a synchronous setState
  // call inside the effect body itself.
  const [mounted, setMounted] = useState(false);
  const [, forceTick] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same SSR-safe "reveal after mount" pattern as theme-toggle.tsx; nothing meaningful to render server-side for a client-local clock.
    setMounted(true);
    const interval = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!mounted) return null;

  return (
    <div
      // `lg`, not `md` — at exactly 768px (`md`) the sidebar ALSO just
      // switched into its fixed-240px desktop layout (see sidebar.tsx's
      // `md:pl-60` on the content area), so showing this widget at the
      // same breakpoint the content area shrinks is what caused the
      // reported 768px horizontal-overflow bug: two independent responsive
      // changes competing for the same narrow window. Waiting until `lg`
      // (1024px) gives the topbar's right-side group enough room.
      className="hidden lg:flex items-center gap-1.5 rounded-md border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground"
      title="Pacific Time (America/Los_Angeles)"
    >
      <Clock className="h-3.5 w-3.5" />
      <span className="font-medium text-foreground">San Francisco</span>
      <span className="tabular-nums">{formatter.format(new Date())} PT</span>
    </div>
  );
}
