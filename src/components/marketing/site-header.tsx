"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { CompassMark } from "@/components/brand/compass-mark";
import { PRODUCT_NAME } from "@/lib/company-config";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "/features", label: "Features" },
  { href: "/about", label: "About" },
  { href: "/security", label: "Security" },
  { href: "/contact", label: "Contact" },
];

// Public marketing site header — completely separate from the
// authenticated CRM's own sidebar/topbar (src/components/layout/sidebar.tsx,
// topbar.tsx), which stay untouched. This never renders on an authenticated
// CRM route.
export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();

  // Subtle elevation once the page has scrolled past the hero — purely a
  // border/shadow change, no layout shift. Passive listener, no
  // per-frame work beyond a single boolean threshold check.
  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 8);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b bg-background/95 backdrop-blur transition-shadow duration-200 supports-[backdrop-filter]:bg-background/80",
        scrolled && "shadow-sm"
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2" aria-label={`${PRODUCT_NAME} home`}>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#12233a]">
            <CompassMark className="h-5 w-5" />
          </div>
          <span className="text-sm font-semibold tracking-tight text-foreground">{PRODUCT_NAME}</span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Main">
          {NAV_LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative py-1 text-sm font-medium transition-colors after:absolute after:inset-x-0 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-foreground after:transition-transform after:duration-200",
                  active ? "text-foreground after:scale-x-100" : "text-muted-foreground after:scale-x-0 hover:text-foreground hover:after:scale-x-100"
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Client Login</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/contact">Get in Touch</Link>
          </Button>
        </div>

        <div className="flex items-center gap-1 md:hidden">
          <ThemeToggle />
          <button
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-md text-foreground"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((v) => !v)}
          >
            {mobileOpen ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-200 border-t bg-background px-4 py-4 md:hidden"
          aria-label="Main mobile"
        >
          <ul className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-2 py-2.5 text-sm font-medium transition-colors",
                      active ? "bg-muted text-foreground" : "text-foreground hover:bg-muted"
                    )}
                    onClick={() => setMobileOpen(false)}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-col gap-2 border-t pt-3">
            <Button asChild variant="outline" size="sm">
              <Link href="/login" onClick={() => setMobileOpen(false)}>
                Client Login
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/contact" onClick={() => setMobileOpen(false)}>
                Get in Touch
              </Link>
            </Button>
          </div>
        </nav>
      )}
    </header>
  );
}
