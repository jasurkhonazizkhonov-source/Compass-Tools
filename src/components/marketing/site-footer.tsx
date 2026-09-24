import Link from "next/link";
import { CompassMark } from "@/components/brand/compass-mark";
import { PRODUCT_NAME } from "@/lib/company-config";
import { MARKETING_FEATURES } from "@/lib/marketing/features-data";

const FOOTER_COLUMNS = [
  {
    heading: "Product",
    links: [
      { href: "/features", label: "All features" },
      ...MARKETING_FEATURES.slice(0, 4).map((f) => ({ href: `/features/${f.slug}`, label: f.navLabel })),
    ],
  },
  {
    heading: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/security", label: "Security" },
      { href: "/contact", label: "Get in Touch" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/privacy", label: "Privacy Policy" },
      { href: "/terms", label: "Terms of Service" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t bg-muted/20">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#12233a]">
                <CompassMark className="h-4 w-4" />
              </div>
              <span className="text-sm font-semibold text-foreground">{PRODUCT_NAME}</span>
            </Link>
            <p className="mt-3 max-w-[220px] text-xs text-muted-foreground">
              The CRM Business Flights Travel&apos;s team uses to manage leads, quotes, and bookings in one place.
            </p>
          </div>
          {FOOTER_COLUMNS.map((col) => (
            <div key={col.heading}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{col.heading}</h3>
              <ul className="mt-3 space-y-2">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-sm text-muted-foreground hover:text-foreground">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; {new Date().getFullYear()} Business Flights Travel. All rights reserved.</p>
          <Link href="/login" className="hover:text-foreground">
            Client Login
          </Link>
        </div>
      </div>
    </footer>
  );
}
