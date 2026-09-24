import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/company-config";
import { MARKETING_FEATURES } from "@/lib/marketing/features-data";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: `Features — ${PRODUCT_NAME}`,
  description: "Explore Compass Tools: lead management, quotes, bookings, customer management, email, follow-up automation, and sales visibility.",
  alternates: { canonical: "/features" },
};

export default function FeaturesPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">Built for how travel agencies work</h1>
        <p className="mt-4 text-muted-foreground">
          Every capability below is part of the same CRM your team already uses — nothing here is a separate product
          or add-on.
        </p>
      </div>

      <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {MARKETING_FEATURES.map((feature) => (
          <Link
            key={feature.slug}
            href={`/features/${feature.slug}`}
            className="group flex flex-col rounded-xl border bg-background p-6 shadow-sm transition-shadow hover:shadow-md"
          >
            <feature.icon className="h-6 w-6 text-[#1c3a5e] dark:text-[#d4a24e]" aria-hidden />
            <h2 className="mt-4 text-base font-semibold text-foreground">{feature.navLabel}</h2>
            <p className="mt-2 flex-1 text-sm text-muted-foreground">{feature.summary}</p>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-foreground">
              Learn more <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </span>
          </Link>
        ))}
      </div>

      <div className="mt-16 flex flex-col items-center gap-4 rounded-2xl border bg-muted/20 px-6 py-10 text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Have a question about a specific workflow?</h2>
        <Button asChild size="lg">
          <Link href="/contact">Get in Touch</Link>
        </Button>
      </div>
    </div>
  );
}
