"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Self-contained replacement for next-themes.
 *
 * Why not next-themes: next-themes (0.4.6, the current published release —
 * confirmed no newer compatible version exists; the only higher version
 * number in its npm history, 1.0.0-beta.0, is a dead 2022 branch published
 * *before* 0.2.1/0.3.0/0.4.x and predates the App Router entirely, not a
 * successor) injects its no-flash theme-bootstrap logic as a real <script>
 * element rendered from inside its own Client Component tree. React 19
 * added a dev-only warning for exactly that shape — a <script> encountered
 * while rendering a Client Component — because React can't statically prove
 * it was part of the initial server HTML (where it legitimately executes)
 * rather than a later client-side-only render (where it wouldn't). This is
 * confirmed reproducible in this app's own dev logs ("Encountered a script
 * tag while rendering React component"), next-themes has no prop to disable
 * its internal script injection, and there's no newer release that fixes
 * it. Root cause lives entirely inside the dependency, not in how this app
 * was already using it — the previous <ThemeProvider {...props}> wrapper
 * around it was already the officially-documented App Router integration.
 *
 * The fix: drop the dependency and reimplement the same behavior (light/
 * dark/system, localStorage persistence under the same "theme" key so an
 * existing visitor's saved preference still applies, cross-tab sync,
 * transition suppression during a theme switch, .dark class + color-scheme
 * on <html>) using the officially-supported Next.js mechanism for exactly
 * this "run an early script before paint to avoid a flash" problem:
 * next/script with strategy="beforeInteractive", rendered directly from the
 * Server Component root layout. Server/next/script-authored scripts are the
 * case React 19's warning specifically does not apply to.
 */

const STORAGE_KEY = "theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

export type Theme = "light" | "dark" | "system";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: "light" | "dark";
  systemTheme: "light" | "dark";
  themes: Theme[];
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light";
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // localStorage unavailable (private mode, disabled) — fall through to default.
  }
  return "system";
}

/** Mirrors next-themes' disableTransitionOnChange: briefly forces every
 * element's CSS transitions off while the .dark class flips, so switching
 * themes doesn't animate every color property at once. */
function withTransitionsDisabled(fn: () => void) {
  const css = document.createElement("style");
  css.appendChild(
    document.createTextNode(
      "*,*::before,*::after{transition:none!important}"
    )
  );
  document.head.appendChild(css);
  fn();
  // Force a style recalculation before removing the override, matching
  // next-themes' own implementation, so the disabled state actually applies
  // to the change made inside fn() before transitions are re-enabled.
  void window.getComputedStyle(document.body).colorScheme;
  window.setTimeout(() => {
    document.head.removeChild(css);
  }, 0);
}

function applyResolvedTheme(resolved: "light" | "dark") {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() => getSystemTheme());

  const resolvedTheme = theme === "system" ? systemTheme : theme;

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage unavailable — theme still applies for this session via state.
    }
  }, []);

  // Track the OS-level preference live, so a "system" selection updates
  // immediately if the user changes their OS setting while the app is open.
  useEffect(() => {
    const mql = window.matchMedia(MEDIA_QUERY);
    const onChange = () => setSystemTheme(mql.matches ? "dark" : "light");
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Cross-tab sync: if another tab changes the theme, follow it here too —
  // matching next-themes' storage-event behavior.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      const next = e.newValue;
      if (next === "light" || next === "dark" || next === "system") setThemeState(next);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Keep <html>'s .dark class / color-scheme in sync with the resolved
  // theme. The very first paint is already correct via the beforeInteractive
  // bootstrap script in the root layout — this effect only runs for
  // subsequent client-side changes (a user toggling theme, the OS
  // preference changing, or another tab's change arriving), so it never
  // introduces a flash of its own.
  useEffect(() => {
    withTransitionsDisabled(() => applyResolvedTheme(resolvedTheme));
  }, [resolvedTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, resolvedTheme, systemTheme, themes: ["light", "dark", "system"] }),
    [theme, setTheme, resolvedTheme, systemTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const FALLBACK: ThemeContextValue = {
  theme: "system",
  setTheme: () => {},
  resolvedTheme: "light",
  systemTheme: "light",
  themes: ["light", "dark", "system"],
};

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext) ?? FALLBACK;
}
