/**
 * Source for the no-flash theme-bootstrap script rendered by the root
 * layout (a Server Component) via next/script's beforeInteractive strategy.
 * Deliberately a plain module (no "use client") so a Server Component can
 * import and stringify it directly.
 *
 * Must be kept logically in sync with src/components/theme-provider.tsx's
 * own resolution (storage key "theme", values "light"/"dark"/"system",
 * same-name .dark class + colorScheme behavior) — this only needs to
 * produce the exact same *first paint* as the client provider will settle
 * into, since the client effect takes over immediately after mount.
 *
 * This runs by being stringified (via .toString()) into an inline <script>,
 * executed by the browser exactly as written, before any application JS
 * (including any bundler's helpers) has loaded — so it must stay
 * self-contained with no closures over anything outside its own body.
 */
export function themeInitScript() {
  try {
    const stored = localStorage.getItem("theme");
    const theme = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    const resolved = theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
    const root = document.documentElement;
    if (resolved === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    root.style.colorScheme = resolved;
  } catch {
    // localStorage/matchMedia can throw (private browsing, storage blocked
    // by an extension/policy, etc.) — this script only sets the *first-paint*
    // theme class as a no-flash optimization, so failing silently and
    // falling back to the page's default (light) styling is strictly better
    // than breaking page load over a cosmetic concern. theme-provider.tsx's
    // client-side effect resolves the real theme immediately after mount
    // regardless of whether this best-effort pre-paint step succeeded.
  }
}
