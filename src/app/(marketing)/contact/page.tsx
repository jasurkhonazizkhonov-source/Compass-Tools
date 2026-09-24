import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/company-config";
import { ContactForm } from "@/components/marketing/contact-form";

export const metadata: Metadata = {
  title: `Get in Touch — ${PRODUCT_NAME}`,
  description: "Send Business Flights Travel a message about a flight request, an existing booking, or corporate travel.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: `Get in Touch — ${PRODUCT_NAME}`,
    description: "Send Business Flights Travel a message about a flight request, an existing booking, or corporate travel.",
    url: "/contact",
    images: [{ url: "/logo.png" }],
  },
};

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">Get in Touch</h1>
        <p className="mt-4 text-muted-foreground">
          Have a question about a flight request, an existing booking, or corporate travel? Send us a message and a
          member of the Business Flights Travel team will get back to you.
        </p>
      </div>

      <div className="mt-10">
        <ContactForm />
      </div>
    </div>
  );
}
