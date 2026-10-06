import type { Metadata } from "next";
import { marketingMetadata } from "@/lib/marketing/seo";
import { PRODUCT_NAME } from "@/lib/company-config";

export const metadata: Metadata = marketingMetadata({
  title: `Terms of Service — ${PRODUCT_NAME}`,
  description: `Terms for using this website and the ${PRODUCT_NAME} CRM.`,
  path: "/terms",
});

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500">
        <h1 className="text-4xl font-semibold tracking-tight text-foreground">Terms of Service</h1>
        <p className="mt-3 text-sm text-muted-foreground">Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" })}</p>
      </div>

      <div className="prose-sm mt-10 space-y-8 text-sm leading-relaxed text-muted-foreground [&_h2]:mb-2 [&_h2]:mt-0 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground">
        <section>
          <h2>Use of this website</h2>
          <p>
            This website describes {PRODUCT_NAME}, a CRM platform for travel agencies. It is provided for general
            informational purposes. You agree to use it lawfully and not to submit false, misleading, or abusive
            content through the Contact form or any other form on this site.
          </p>
        </section>
        <section>
          <h2>Contact form submissions</h2>
          <p>
            Submitting the Contact form does not create any booking, purchase, or binding agreement — it is a
            request for our team to get back to you about {PRODUCT_NAME}. It is not a channel for a travel
            agency&apos;s own customers to make or change a travel booking; a traveler with a booking question should
            use the specific travel agency&apos;s own website or contact information.
          </p>
        </section>
        <section>
          <h2>Use of the CRM application</h2>
          <p>
            Access to the {PRODUCT_NAME} application (Client Login) is restricted to authorized staff of the travel
            agencies that use it. An account holder is responsible for keeping their account secure and for the
            accuracy of the information they enter into the system. Attempting to access the application without
            authorization, or to use it to store or process information you are not authorized to handle, is
            prohibited.
          </p>
        </section>
        <section>
          <h2>Acceptable use</h2>
          <p>
            You agree not to use {PRODUCT_NAME} or this website to violate any law, to attempt to bypass its security
            controls, to interfere with its normal operation, or to collect, store, or transmit payment card data
            outside of the application&apos;s own built-in card-handling feature.
          </p>
        </section>
        <section>
          <h2>Customer data responsibility</h2>
          <p>
            Where a travel agency enters its own customers&apos; information into {PRODUCT_NAME}, that agency is
            responsible for having the right to collect and use that information, and for its own communications
            with its customers. {PRODUCT_NAME} stores and processes that information on the agency&apos;s behalf, as
            described in our{" "}
            <a href="/privacy" className="underline underline-offset-4 transition-colors hover:text-foreground">
              Privacy Policy
            </a>
            .
          </p>
        </section>
        <section>
          <h2>Third-party integrations</h2>
          <p>
            {PRODUCT_NAME} integrates with Google Sign-In and, where a user chooses to connect it, the Gmail API to
            send email on that user&apos;s behalf. Use of those integrations is also subject to Google&apos;s own
            terms. We are not responsible for the availability of these third-party services.
          </p>
        </section>
        <section>
          <h2>Service availability</h2>
          <p>
            We aim to keep {PRODUCT_NAME} available and reliable, but do not guarantee uninterrupted access.
            Maintenance, third-party outages (including our hosting, database, or email providers), or unforeseen
            issues may occasionally affect availability.
          </p>
        </section>
        <section>
          <h2>Disclaimers and limitation of liability</h2>
          <p>
            {PRODUCT_NAME} is provided on an &quot;as is&quot; basis without warranties of any kind, express or implied. To the
            fullest extent permitted by law, {PRODUCT_NAME} is not liable for indirect, incidental, or consequential
            damages arising from use of this website or the application.
          </p>
        </section>
        <section>
          <h2>Changes to these terms</h2>
          <p>We may update these terms from time to time. The date above reflects the most recent revision.</p>
        </section>
        <section>
          <h2>Contact</h2>
          <p>
            Questions about these terms can be sent through our{" "}
            <a href="/contact" className="underline underline-offset-4 transition-colors hover:text-foreground">
              Contact
            </a>{" "}
            page.
          </p>
        </section>
      </div>
    </div>
  );
}
