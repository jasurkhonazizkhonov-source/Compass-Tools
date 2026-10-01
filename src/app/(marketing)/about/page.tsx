import Link from "next/link";
import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/company-config";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/reveal";

export const metadata: Metadata = {
  title: `About — ${PRODUCT_NAME}`,
  description: "Compass Tools is a CRM built for travel agencies to manage leads, quotes, bookings, and customer communication.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <h1 className="text-4xl font-semibold tracking-tight text-balance text-foreground">About {PRODUCT_NAME}</h1>
        <div className="mt-6 max-w-2xl space-y-5 text-pretty text-muted-foreground">
          <p>
            {PRODUCT_NAME} is a CRM built for travel agencies to manage leads, build fare quotes, track bookings, and
            stay in touch with customers every day. It is built around the way a travel agency actually operates — a
            lead comes in, an agent builds a quote, a customer signs and books, and the team follows up — rather than a
            generic sales pipeline adapted after the fact.
          </p>
          <p>
            Every lead is tracked from first contact through booking, every quote reflects real GDS itinerary data, and
            every booking&apos;s status reflects real ticketing events. The goal is straightforward: give agents one
            place to work, and give managers a clear, accurate view of what&apos;s happening across the team.
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
