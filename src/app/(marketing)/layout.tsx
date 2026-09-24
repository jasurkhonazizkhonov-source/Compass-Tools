import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/site-footer";

// Shared chrome for every public marketing page (homepage, /features,
// /about, /contact, /security, /privacy, /terms). Completely separate from
// the authenticated CRM's own (crm)/layout.tsx — a sibling route group
// under src/app/, not nested inside it, so neither affects the other's
// data fetching, session checks, or rendering.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
