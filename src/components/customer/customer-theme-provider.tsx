"use client";

import { createContext, useContext, useState } from "react";
import { cn } from "@/lib/utils";

type CustomerTheme = "light" | "dark";

const CustomerThemeContext = createContext<{
  theme: CustomerTheme;
  toggleTheme: () => void;
  portalContainer: HTMLElement | null;
} | null>(null);

const STORAGE_KEY = "bft-customer-theme";

/**
 * Independent from the CRM's app-wide ThemeProvider (@/components/theme-provider — which
 * defaults to the visitor's OS/system preference — appropriate for the
 * internal CRM, wrong for a customer-facing page). This always starts in
 * light mode regardless of system preference; a customer can still switch
 * to dark manually, and that choice is remembered separately from any CRM
 * agent's own theme preference on a shared browser.
 */
export function CustomerThemeProvider({ children }: { children: React.ReactNode }) {
  // Lazy-initialized so the very first paint (server-rendered and the
  // client's pre-hydration pass) is always light — matching "never
  // automatically force dark mode" — with a returning customer's saved
  // choice picked up as soon as the client can read localStorage.
  const [theme, setTheme] = useState<CustomerTheme>(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "dark" ? "dark" : "light";
  });
  // Radix portals (Select/Popover/Dialog/etc.) default to document.body,
  // which sits OUTSIDE this div and its scoped color tokens — they'd
  // otherwise inherit the CRM's ambient (system-preference-driven) .dark
  // class instead of the customer's own light/dark choice. Consumers can
  // point a portal's `container` prop at this node instead. State (not a
  // bare ref) so consumers re-render once the node exists post-mount.
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);

  function toggleTheme() {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      window.localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }

  return (
    <CustomerThemeContext.Provider value={{ theme, toggleTheme, portalContainer }}>
      <div
        ref={setPortalContainer}
        suppressHydrationWarning
        className={cn("min-h-screen bg-background", theme === "dark" ? "customer-theme-dark" : "customer-theme-light")}
      >
        {children}
      </div>
    </CustomerThemeContext.Provider>
  );
}

export function useCustomerTheme() {
  const ctx = useContext(CustomerThemeContext);
  if (!ctx) throw new Error("useCustomerTheme must be used within CustomerThemeProvider");
  return ctx;
}
