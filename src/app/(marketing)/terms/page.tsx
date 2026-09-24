import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/company-config";

export const metadata: Metadata = {
  title: `Terms of Service — ${PRODUCT_NAME}`,
  description: "Terms for using this website and submitting inquiries to Business Flights Travel.",
  alternates: { canonical: "/terms" },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <h1 className="text-4xl font-semibold tracking-tight text-foreground">Terms of Service</h1>
      <p className="mt-3 text-sm text-muted-foreground">Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" })}</p>

      <div className="prose-sm mt-10 space-y-8 text-sm leading-relaxed text-muted-foreground [&_h2]:mb-2 [&_h2]:mt-0 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground">
        <section>
          <h2>Use of this website</h2>
          <p>
            This website provides information about Business Flights Travel and the {PRODUCT_NAME} CRM used by our
            team. It is provided for general informational purposes. You agree to use it lawfully and not to submit
            false, misleading, or abusive content through any form on this site.
          </p>
        </section>
        <section>
          <h2>Inquiries</h2>
          <p>
            Submitting the Get in Touch form does not create a booking or a binding agreement. It is a request for
            our team to contact you. Any actual flight booking is subject to the separate terms and conditions
            presented at the time of booking.
          </p>
        </section>
        <section>
          <h2>Client login</h2>
          <p>
            The CRM login is restricted to authorized Business Flights Travel staff. Attempting to access it without
            authorization is prohibited.
          </p>
        </section>
        <section>
          <h2>Changes</h2>
          <p>We may update these terms from time to time. The date above reflects the most recent revision.</p>
        </section>
        <section>
          <h2>Contact</h2>
          <p>
            Questions about these terms can be sent through our{" "}
            <a href="/contact" className="underline underline-offset-4 hover:text-foreground">
              Get in Touch
            </a>{" "}
            page.
          </p>
        </section>
      </div>
    </div>
  );
}
