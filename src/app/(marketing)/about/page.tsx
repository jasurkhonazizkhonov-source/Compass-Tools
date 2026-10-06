import Link from "next/link";
import type { Metadata } from "next";
import { marketingMetadata, pageJsonLd } from "@/lib/marketing/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { MARKETING_FEATURES } from "@/lib/marketing/features-data";
import { PRODUCT_NAME } from "@/lib/company-config";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/reveal";

const ABOUT_DESCRIPTION =
  "Who Compass Tools is for and what it does: a travel-agency CRM that follows the real path from lead to quote to booking, with one place for agents and a clear team view for managers.";

export const metadata: Metadata = marketingMetadata({ title: `About — ${PRODUCT_NAME}`, description: ABOUT_DESCRIPTION, path: "/about" });

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <JsonLd data={pageJsonLd("AboutPage", { name: `About ${PRODUCT_NAME}`, description: ABOUT_DESCRIPTION, path: "/about" })} />
      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <h1 className="text-4xl font-semibold tracking-tight text-balance text-foreground">About {PRODUCT_NAME}</h1>
        <div className="mt-6 max-w-2xl space-y-5 text-pretty text-muted-foreground">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">What is {PRODUCT_NAME}?</h2>
          <p>
            {PRODUCT_NAME} is a CRM built for travel agencies to manage leads, build fare quotes, track bookings, and
            stay in touch with customers every day. It is built around the way a travel agency actually operates — a
            lead comes in, an agent builds a quote, a customer signs and books, and the team follows up — rather than a
            generic sales pipeline adapted after the fact.
          </p>
          <h2 className="pt-2 text-xl font-semibold tracking-tight text-foreground">Who is it for?</h2>
          <p>
            {PRODUCT_NAME} is for travel agencies: the agents who handle leads and build quotes, the staff who track
            ticketing and bookings, and the managers and administrators who need an accurate view of what is happening
            across the team. What each person can see and do depends on their role.
          </p>
          <h2 className="pt-2 text-xl font-semibold tracking-tight text-foreground">What does it provide?</h2>
          <p>
            Every lead is tracked from first contact through booking, every quote reflects real GDS itinerary data, and
            every booking&apos;s status reflects real ticketing events. The goal is straightforward: give agents one
            place to work, and give managers a clear, accurate view of what&apos;s happening across the team.
          </p>
          <ul className="space-y-2 text-sm">
            {MARKETING_FEATURES.map((f) => (
              <li key={f.slug}>
                <Link href={`/features/${f.slug}`} className="font-medium text-foreground underline underline-offset-4 transition-colors hover:text-primary">
                  {f.navLabel}
                </Link>{" "}
                — {f.summary}
              </li>
            ))}
          </ul>
          <h2 className="pt-2 text-xl font-semibold tracking-tight text-foreground">How can I contact {PRODUCT_NAME}?</h2>
          <p>
            Use the <Link href="/contact" className="font-medium text-foreground underline underline-offset-4 transition-colors hover:text-primary">contact form</Link> to ask
            about a demo, a feature, technical support or billing. How {PRODUCT_NAME} handles information is described on
            the <Link href="/security" className="font-medium text-foreground underline underline-offset-4 transition-colors hover:text-primary">Security</Link> and{" "}
            <Link href="/privacy" className="font-medium text-foreground underline underline-offset-4 transition-colors hover:text-primary">Privacy</Link> pages.
          </p>
        </div>
      </div>
      <Reveal className="mt-10 flex flex-col gap-3 sm:flex-row" delayMs={100}>
        <Button asChild size="lg">
          <Link href="/features">Explore features</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/contact">Get in Touch</Link>
        </Button>
      </Reveal>
    </div>
  );
}
