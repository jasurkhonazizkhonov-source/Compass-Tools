import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/company-config";
import { MARKETING_FEATURES, getFeatureBySlug } from "@/lib/marketing/features-data";
import { Button } from "@/components/ui/button";
import { MockLeadsPanel, MockQuotePanel, MockDashboardPanel } from "@/components/marketing/mock-crm-panel";

// One dynamic route rendering all seven /features/<slug> pages from a
// single typed data source (src/lib/marketing/features-data.ts) rather
// than seven near-duplicate page files — produces the exact URLs
// requested (/features/leads, /features/quotes, etc.) while keeping the
// actual page markup in one place. generateStaticParams pre-renders every
// known slug at build time; an unknown slug still correctly 404s via
// notFound() below rather than crashing.
export function generateStaticParams() {
  return MARKETING_FEATURES.map((f) => ({ slug: f.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const feature = getFeatureBySlug(slug);
  if (!feature) return {};
  return {
    title: `${feature.navLabel} — ${PRODUCT_NAME}`,
    description: feature.summary,
    alternates: { canonical: `/features/${feature.slug}` },
  };
}

const MOCK_PANEL_BY_SLUG: Record<string, React.ComponentType> = {
  leads: MockLeadsPanel,
  "customer-management": MockLeadsPanel,
  quotes: MockQuotePanel,
  bookings: MockQuotePanel,
  analytics: MockDashboardPanel,
};

export default async function FeatureDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const feature = getFeatureBySlug(slug);
  if (!feature) notFound();

  const MockPanel = MOCK_PANEL_BY_SLUG[feature.slug] ?? MockDashboardPanel;
  const Icon = feature.icon;

  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
      <Link href="/features" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> All features
      </Link>

      <div className="mt-8 grid items-center gap-10 lg:grid-cols-2">
        <div>
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#12233a]">
            <Icon className="h-5 w-5 text-white" aria-hidden />
          </div>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">{feature.headline}</h1>
          <p className="mt-4 text-muted-foreground">{feature.description}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg" className="gap-2">
              <Link href="/contact">
                Get in Touch <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/login">Client Login</Link>
            </Button>
          </div>
        </div>
        <MockPanel />
      </div>

      <div className="mt-16 rounded-2xl border bg-muted/20 p-8">
        <h2 className="text-lg font-semibold text-foreground">What&apos;s included</h2>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2">
          {feature.bullets.map((bullet) => (
            <li key={bullet} className="flex items-start gap-2 text-sm text-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              {bullet}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-14 flex flex-wrap gap-3 border-t pt-8">
        <span className="text-sm text-muted-foreground">Explore more:</span>
        {MARKETING_FEATURES.filter((f) => f.slug !== feature.slug)
          .slice(0, 3)
          .map((f) => (
            <Link key={f.slug} href={`/features/${f.slug}`} className="text-sm font-medium text-foreground underline underline-offset-4 hover:text-[#1c3a5e] dark:hover:text-[#d4a24e]">
              {f.navLabel}
            </Link>
          ))}
      </div>
    </div>
  );
}
