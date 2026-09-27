import type { Metadata } from "next";
import { Plane, Clock, ShieldCheck } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/company-config";
import { ContactForm } from "@/components/marketing/contact-form";

export const metadata: Metadata = {
  title: `Contact Us — ${PRODUCT_NAME}`,
  description:
    "Contact Business Flights Travel about a flight booking, quote request, existing reservation, or corporate travel program. We typically reply within one business day.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: `Contact Us — ${PRODUCT_NAME}`,
    description: "Contact Business Flights Travel about a flight booking, quote request, existing reservation, or corporate travel program.",
    url: "/contact",
    images: [{ url: "/logo.png" }],
  },
};

const REASSURANCES = [
  { icon: Plane, title: "Real travel specialists", body: "Your inquiry is reviewed by a member of the Business Flights Travel team, not an automated reply." },
  { icon: Clock, title: "Prompt response", body: "We aim to get back to you through the phone number or email address you provide." },
  { icon: ShieldCheck, title: "Sent securely", body: "Your message is submitted over HTTPS. Never include card numbers or other sensitive financial details." },
];

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">Contact Business Flights Travel</h1>
        <p className="mt-4 text-muted-foreground">
          Have a question about a flight booking, a quote request, an existing reservation, or corporate travel? Send us a
          message below and a member of our team will get back to you.
        </p>
      </div>

      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500 mt-10 grid gap-4 sm:grid-cols-3">
        {REASSURANCES.map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-xl border bg-background p-4 shadow-sm">
            <Icon className="h-5 w-5 text-[#1c3a5e] dark:text-[#d4a24e]" aria-hidden />
            <h2 className="mt-2 text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>

      <div className="mt-8">
        <ContactForm />
      </div>
    </div>
  );
}
