import Link from "next/link";
import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/company-config";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: `About — ${PRODUCT_NAME}`,
  description: "Compass Tools is the CRM built for and used by Business Flights Travel's own agents.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <h1 className="text-4xl font-semibold tracking-tight text-foreground">About {PRODUCT_NAME}</h1>
      <div className="mt-6 space-y-5 text-muted-foreground">
        <p>
          {PRODUCT_NAME} is the CRM Business Flights Travel&apos;s own team uses every day to manage leads, build
          fare quotes, track bookings, and stay in touch with customers. It was built around the way a real travel
          agency actually operates — a lead comes in, an agent builds a quote, a customer signs and books, and the
          team follows up — rather than a generic sales pipeline adapted after the fact.
        </p>
        <p>
          Every lead is tracked from first contact through booking, every quote reflects real GDS itinerary data, and
          every booking&apos;s status reflects real ticketing events. The goal is straightforward: give agents one
          place to work, and give managers a clear, accurate view of what&apos;s happening across the team.
        </p>
      </div>
      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <Button asChild size="lg">
          <Link href="/features">Explore features</Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href="/contact">Get in Touch</Link>
        </Button>
      </div>
    </div>
  );
}
