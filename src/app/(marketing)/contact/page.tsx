import type { Metadata } from "next";
import { LayoutDashboard, Clock, ShieldCheck } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/company-config";
import { ContactForm } from "@/components/marketing/contact-form";

// This page is Compass Tools' OWN public contact form (posts to
// /api/public/crm-inquiry, shown only in the Admin "CRM Inquiries" inbox —
// see src/server/public-inquiry.ts). It is for questions about the CRM
// product itself (demos, features, support, billing) — never for Business
// Flights Travel's travel-customer inquiries, which are a completely
// separate website and system (businessflights.travel →
// /api/public/contact-inquiry → the "Get In Touch" inbox). Copy here must
// read as "contact Compass Tools", not "contact a travel agency".
export const metadata: Metadata = {
  title: `Contact Us — ${PRODUCT_NAME}`,
  description: "Questions about Compass Tools — a demo, a feature, technical support, or billing? Send us a message and our team will get back to you.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: `Contact Us — ${PRODUCT_NAME}`,
    description: "Questions about Compass Tools — a demo, a feature, technical support, or billing? Send us a message and our team will get back to you.",
    url: "/contact",
    images: [{ url: "/logo.png" }],
  },
};

const REASSURANCES = [
  { icon: LayoutDashboard, title: "A real person reviews it", body: `Your message is reviewed by a member of the ${PRODUCT_NAME} team, not an automated reply.` },
  { icon: Clock, title: "Prompt response", body: "We aim to get back to you through the phone number or email address you provide." },
  { icon: ShieldCheck, title: "Sent securely", body: "Your message is submitted over HTTPS. Never include card numbers or other sensitive financial details." },
];

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">Contact {PRODUCT_NAME}</h1>
        <p className="mt-4 text-muted-foreground">
          Have a question about a demo, a feature, your account, or billing? Send us a message below and our team will get
          back to you.
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
