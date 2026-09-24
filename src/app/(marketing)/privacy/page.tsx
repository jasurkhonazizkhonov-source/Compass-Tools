import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/company-config";

export const metadata: Metadata = {
  title: `Privacy Policy — ${PRODUCT_NAME}`,
  description: "How Business Flights Travel collects and uses information submitted through this website.",
  alternates: { canonical: "/privacy" },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <h1 className="text-4xl font-semibold tracking-tight text-foreground">Privacy Policy</h1>
      <p className="mt-3 text-sm text-muted-foreground">Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" })}</p>

      <div className="prose-sm mt-10 space-y-8 text-sm leading-relaxed text-muted-foreground [&_h2]:mb-2 [&_h2]:mt-0 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground">
        <section>
          <h2>Information we collect</h2>
          <p>
            When you submit the Get in Touch form on this website, we collect the information you provide: your
            name, email address, phone number (if given), the subject you select, and your message. We do not
            require you to create an account or sign in to submit an inquiry.
          </p>
        </section>
        <section>
          <h2>How we use it</h2>
          <p>
            We use the information you submit to respond to your inquiry and, where relevant, to follow up about
            travel arrangements. Your submission is stored in our internal CRM system, visible only to authorized
            Business Flights Travel staff.
          </p>
        </section>
        <section>
          <h2>Staff access</h2>
          <p>
            Access to any information submitted through this site is limited to Business Flights Travel team
            members who sign in with a verified, authorized account. We do not sell the information you submit to
            third parties.
          </p>
        </section>
        <section>
          <h2>Data retention</h2>
          <p>
            We retain inquiry and customer information for as long as reasonably necessary to provide our services
            and maintain accurate business records.
          </p>
        </section>
        <section>
          <h2>Contact</h2>
          <p>
            Questions about this policy or a request regarding your information can be sent through our{" "}
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
