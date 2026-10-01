import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/site-footer";
import { PRODUCT_NAME, resolveBaseUrl } from "@/lib/company-config";

// Shared chrome for every public marketing page (homepage, /features,
// /about, /contact, /security, /privacy, /terms). Completely separate from
// the authenticated CRM's own (crm)/layout.tsx — a sibling route group
// under src/app/, not nested inside it, so neither affects the other's
// data fetching, session checks, or rendering.
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  const base = resolveBaseUrl();
  // Minimal, factual WebSite structured data — name and URL only, both
  // already used elsewhere in this app's own metadata. Deliberately does
  // NOT add Organization/SoftwareApplication fields (founding date,
  // address, ratings, pricing, certifications) that would have to be
  // invented rather than sourced from anything real in this repository.
  // Scoped to this layout (not the root layout) so it never renders on an
  // authenticated CRM page.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: PRODUCT_NAME,
    url: base,
  };

  return (
    <div className="flex min-h-screen flex-col">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
