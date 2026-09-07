"use client";

import { Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCustomerTheme } from "@/components/customer/customer-theme-provider";
import { cn } from "@/lib/utils";

export function CustomerHeader({
  subtitle,
  maxWidth = "max-w-2xl",
  action,
  logoUrl,
  companyName,
}: {
  subtitle: string;
  maxWidth?: string;
  /** Optional extra control rendered at the top-right, before the theme
   * toggle — e.g. a Close button on the confirmation page, so it's visible
   * without scrolling. */
  action?: React.ReactNode;
  /** From the record's own owning Company (see
   * src/server/queries/company.ts's getCompanyForContactId) — fetched by
   * the parent Server Component page, since this is a client component and
   * can't query the DB directly. */
  logoUrl: string;
  companyName: string;
}) {
  const { theme, toggleTheme } = useCustomerTheme();
  return (
    <header className="border-b bg-background">
      <div className={cn(maxWidth, "mx-auto px-4 py-5 flex items-center gap-3")}>
        {/* eslint-disable-next-line @next/next/no-img-element -- DB-referenced local asset, no remote-image optimization needed */}
        <img src={logoUrl} alt={companyName} className="h-9 w-auto object-contain object-center shrink-0" />
        <p className="text-[11px] text-muted-foreground truncate min-w-0">{subtitle}</p>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {action}
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </header>
  );
}
