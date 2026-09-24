import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { getCurrentAccount } from "@/lib/dev-session";
import { PRODUCT_NAME } from "@/lib/company-config";
import { MARKETING_FEATURES } from "@/lib/marketing/features-data";
import { Button } from "@/components/ui/button";
import { MockLeadsPanel, MockQuotePanel, MockDashboardPanel } from "@/components/marketing/mock-crm-panel";

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — CRM for Business Flights Travel`,
  description:
    "Compass Tools is the CRM Business Flights Travel's team uses to manage leads, quotes, bookings, and customer communication in one place.",
  alternates: { canonical: "/" },
  openGraph: {
    title: `${PRODUCT_NAME} — CRM for Business Flights Travel`,
    description: "Manage leads, quotes, bookings, and customer communication in one place.",
    url: "/",
    type: "website",
    images: [{ url: "/logo.png" }],
  },
};

const WORKFLOW_STEPS = ["Lead", "Quote", "Customer", "Booking", "Communication", "Follow-up"];

// Real bug/routing conflict found and fixed: this route used to be a bare
// `redirect("/dashboard")` (src/app/page.tsx, now replaced by this file),
// with "/" itself gated by src/proxy.ts's matcher — meaning an
// unauthenticated visitor to the bare domain was sent straight to /login
// with no public page ever reachable. Making "/" a real public marketing
// homepage requires removing "/" from proxy.ts's matcher (done) and having
// this page perform its own auth check instead — the exact same pattern
// /login already uses (redirect signed-in visitors to /dashboard; render
// the public page otherwise) — so a signed-in CRM user typing the bare
// domain keeps landing on their dashboard exactly as before.
export default async function HomePage() {
  const current = await getCurrentAccount();
  if (current) {
    redirect("/dashboard");
  }

  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden border-b bg-muted/20">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage: "radial-gradient(circle at 85% 10%, rgba(212,162,78,0.12), transparent 45%)",
          }}
        />
        <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              One CRM for every lead, quote, and booking
            </h1>
            <p className="mt-5 text-lg text-muted-foreground">
              {PRODUCT_NAME} is the CRM Business Flights Travel&apos;s team uses to manage leads, build quotes, track
              bookings, and communicate with customers — all in one place.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
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
        </div>
      </section>

      {/* Workflow overview */}
      <section className="border-b py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            The complete workflow
          </h2>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {WORKFLOW_STEPS.map((step, i) => (
              <div key={step} className="flex items-center gap-3">
                <span className="rounded-full border bg-background px-4 py-2 text-sm font-medium text-foreground shadow-sm">{step}</span>
                {i < WORKFLOW_STEPS.length - 1 && <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Product preview */}
      <section className="border-b py-16 sm:py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">See the whole pipeline at a glance</h2>
            <p className="mt-4 text-muted-foreground">
              The dashboard gives agents and managers a real-time view of leads, quotes, and bookings — while every
              individual lead keeps a complete, ordered history of what&apos;s happened so far.
            </p>
            <ul className="mt-6 space-y-3">
              {["Automatic lead distribution to available agents", "Branded, secure customer-facing quote pages", "Booking status that updates with real ticketing events"].map(
                (item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-foreground">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    {item}
                  </li>
                )
              )}
            </ul>
          </div>
          <div className="space-y-4">
            <MockDashboardPanel />
            <MockLeadsPanel />
          </div>
        </div>
      </section>

      {/* Feature grid */}
      <section className="border-b py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">Everything your team needs</h2>
            <p className="mt-3 text-muted-foreground">Built around how a travel agency actually works.</p>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {MARKETING_FEATURES.map((feature) => (
              <Link
                key={feature.slug}
                href={`/features/${feature.slug}`}
                className="group rounded-xl border bg-background p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                <feature.icon className="h-6 w-6 text-[#1c3a5e] dark:text-[#d4a24e]" aria-hidden />
                <h3 className="mt-4 text-sm font-semibold text-foreground">{feature.navLabel}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{feature.summary}</p>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-foreground opacity-0 transition-opacity group-hover:opacity-100">
                  Learn more <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Quote preview + CTA */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-2">
          <div className="order-2 lg:order-1">
            <MockQuotePanel />
          </div>
          <div className="order-1 lg:order-2">
            <h2 className="text-3xl font-semibold tracking-tight text-foreground">Ready when your customer is</h2>
            <p className="mt-4 text-muted-foreground">
              Quotes go out branded and ready to act on — customers review and continue to booking without ever
              needing a CRM login.
            </p>
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
        </div>
      </section>
    </>
  );
}
