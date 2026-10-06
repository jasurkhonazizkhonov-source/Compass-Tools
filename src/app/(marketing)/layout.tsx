import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SkipLink } from "@/components/layout/skip-link";
import { JsonLd } from "@/components/marketing/json-ld";
import { siteJsonLd } from "@/lib/marketing/seo";

// Shared chrome for every public marketing page (homepage, /features,
// /about, /contact, /security, /privacy, /terms). Completely separate from
// the authenticated CRM's own (crm)/layout.tsx — a sibling route group
// under src/app/, not nested inside it, so neither affects the other's
// data fetching, session checks, or rendering.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SkipLink />
      {/* Site-wide WebSite + Organization entities (name, URL, logo only — see lib/marketing/seo.ts). Scoped to this layout, never the
          root layout, so it never renders on an authenticated CRM page. */}
      <JsonLd data={siteJsonLd()} />
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="flex-1 outline-none">{children}</main>
      <SiteFooter />
    </div>
  );
}
