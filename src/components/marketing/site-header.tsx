"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { CompassMark } from "@/components/brand/compass-mark";
import { PRODUCT_NAME } from "@/lib/company-config";
import { Button } from "@/components/ui/button";

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

  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2" aria-label={`${PRODUCT_NAME} home`}>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#12233a]">
            <CompassMark className="h-5 w-5" />
          </div>
          <span className="text-sm font-semibold tracking-tight text-foreground">{PRODUCT_NAME}</span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Main">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Client Login</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/contact">Get in Touch</Link>
          </Button>
        </div>

        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-md text-foreground md:hidden"
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {mobileOpen && (
        <nav className="border-t bg-background px-4 py-4 md:hidden" aria-label="Main mobile">
          <ul className="flex flex-col gap-1">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="block rounded-md px-2 py-2.5 text-sm font-medium text-foreground hover:bg-muted"
                  onClick={() => setMobileOpen(false)}
                >
                  {link.label}
                </Link>
              </li>
            ))}
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
