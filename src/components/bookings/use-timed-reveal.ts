"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const REVEAL_TIMEOUT_SECONDS = 30;

/**
 * Holds a revealed card number in component state only, and conceals it:
 *   - after REVEAL_TIMEOUT_SECONDS,
 *   - immediately when the tab is hidden or the window loses focus,
 *   - when the component unmounts.
 * Nothing is written to storage, the URL or the clipboard. Both timers are
 * always cleared, so nothing fires against an unmounted component.
 *
 * Two independent timers on purpose: the interval only decrements the displayed
 * countdown; a single one-shot timeout is the only thing that conceals.
 */
export function useTimedReveal<T>() {
  const [value, setValue] = useState<T | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_TIMEOUT_SECONDS);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (tick.current) clearInterval(tick.current);
    if (expiry.current) clearTimeout(expiry.current);
    tick.current = null;
    expiry.current = null;
  }, []);

  const hide = useCallback(() => {
    clearTimers();
    setValue(null);
  }, [clearTimers]);

  const show = useCallback(
    (next: T) => {
      clearTimers();
      setValue(next);
      setSecondsLeft(REVEAL_TIMEOUT_SECONDS);
      tick.current = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
      expiry.current = setTimeout(hide, REVEAL_TIMEOUT_SECONDS * 1000);
    },
    [clearTimers, hide]
  );

  useEffect(() => {
    if (value === null) return;
    const concealIfLeft = () => {
      if (document.visibilityState === "hidden") hide();
    };
    document.addEventListener("visibilitychange", concealIfLeft);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("visibilitychange", concealIfLeft);
      window.removeEventListener("blur", hide);
    };
  }, [value, hide]);

  useEffect(() => clearTimers, [clearTimers]);

  return { value, secondsLeft, show, hide };
}
