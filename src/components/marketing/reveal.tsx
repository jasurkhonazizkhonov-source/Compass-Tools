"use client";

import { useEffect, useRef } from "react";

/**
 * Scroll-triggered entrance for below-the-fold public marketing sections.
 * Progressive enhancement, not a dependency: the wrapped content renders
 * fully visible by default (plain div, no inline style, no class that
 * hides it) — a visitor with JavaScript disabled, slow, or blocked sees
 * the real content immediately, same as without this component at all.
 * Only once this effect actually runs does it apply an opacity/transform
 * starting state via direct style mutation (not React state — no re-render
 * needed), then reveals it the first time it scrolls into view and
 * disconnects. Skips the animation (and its initial hidden state)
 * entirely when the visitor prefers reduced motion, per the same
 * motion-safe convention already used elsewhere on this site, so reduced-
 * motion visitors never see even a brief opacity dip.
 */
export function Reveal({
  children,
  className,
  delayMs = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delayMs?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    el.style.opacity = "0";
    el.style.transform = "translateY(16px)";
    el.style.transition = `opacity 600ms ease-out ${delayMs}ms, transform 600ms ease-out ${delayMs}ms`;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
        observer.disconnect();
      },
      { threshold: 0.15, rootMargin: "0px 0px -10% 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [delayMs]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
