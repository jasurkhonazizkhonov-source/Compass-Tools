import type { Metadata } from "next";
import { PRODUCT_NAME } from "@/lib/company-config";

export const metadata: Metadata = {
  title: `Privacy Policy — ${PRODUCT_NAME}`,
  description: `How ${PRODUCT_NAME} collects, stores, and protects information, for both visitors to this website and users of the CRM.`,
  alternates: { canonical: "/privacy" },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <h1 className="text-4xl font-semibold tracking-tight text-foreground">Privacy Policy</h1>
      <p className="mt-3 text-sm text-muted-foreground">Last updated: {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long" })}</p>
      <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
        {PRODUCT_NAME} is a customer-relationship-management (CRM) platform built for travel agencies. This policy
        covers two separate things: (1) this public website, and (2) the {PRODUCT_NAME} application itself, used by
        the staff of the travel agencies (&quot;customers&quot;) that run their business on it.
      </p>

      <div className="prose-sm mt-10 space-y-8 text-sm leading-relaxed text-muted-foreground [&_h2]:mb-2 [&_h2]:mt-0 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground">
        <section>
          <h2>This website</h2>
          <p>
            When you submit the Contact form on this website, we collect what you provide: your name, email address,
            phone number, the topic you select, and your message. We do not require an account to submit a message,
            and this form is handled entirely separately from any individual travel agency&apos;s own customer
            inquiries (see &quot;Two separate systems&quot; below).
          </p>
        </section>
        <section>
          <h2>Two separate systems</h2>
          <p>
            {PRODUCT_NAME} is the CRM platform; it is also used by Business Flights Travel, one of the travel
            agencies that runs on it. This website&apos;s own Contact form (above) is about {PRODUCT_NAME} the
            product — a demo, a feature question, support, billing. It is kept entirely separate, in its own
            database records and its own inbox visible only to {PRODUCT_NAME}&apos;s own team, from any inquiry a
            traveler submits to a travel agency&apos;s own customer-facing website. We do not combine these.
          </p>
        </section>
        <section>
          <h2>Information CRM users enter into the application</h2>
          <p>
            Travel agency staff who use {PRODUCT_NAME} enter information about their own leads, customers, quotes,
            and bookings — names, contact details, travel preferences, pricing, and (where a customer pays by card)
            payment card information. This information belongs to the travel agency; {PRODUCT_NAME} stores and
            processes it on the agency&apos;s behalf so their staff can do their jobs, and does not use it for any
            other purpose, such as marketing to those customers directly.
          </p>
        </section>
        <section>
          <h2>Payment card information</h2>
          <p>
            Where a travel agency collects a customer&apos;s card details for a booking, the card number is encrypted
            before storage using the application&apos;s own key-based encryption, and is only ever decrypted by an
            explicitly authorized staff member completing a manual charge with a supplier. The short security code
            printed on the back of the card is never requested, collected, or stored by {PRODUCT_NAME} under any
            circumstances. We do not claim any particular payment-industry certification (such as PCI DSS) for this
            functionality.
          </p>
        </section>
        <section>
          <h2>Account sign-in (CRM staff)</h2>
          <p>
            Staff accounts sign in to the CRM with Google Sign-In. We receive the basic profile information Google
            provides (name, email address) to identify the account; we do not receive or store the Google account
            password. A staff member may separately, explicitly connect their own Gmail account so the CRM can send
            email (such as a quote) on their behalf — this is a distinct authorization from signing in, limited to
            sending mail, and can be disconnected at any time.
          </p>
        </section>
        <section>
          <h2>Cookies and local storage</h2>
          <p>
            This website and the CRM application use a session cookie to keep a signed-in user logged in, and
            browser local storage to remember a visitor&apos;s light/dark theme preference. We do not use
            advertising or third-party tracking cookies.
          </p>
        </section>
        <section>
          <h2>Security measures</h2>
          <p>
            Access to customer data within the CRM is restricted by role and by which records a given staff account
            is permitted to see. Sensitive actions (such as revealing a stored card number) are logged, rate-limited,
            and require a recent sign-in. All traffic to this website and the CRM is served over HTTPS.
          </p>
        </section>
        <section>
          <h2>Service providers</h2>
          <p>
            We use Google (for sign-in and, where connected, Gmail sending), a managed PostgreSQL database provider,
            and Vercel (for application hosting) to operate {PRODUCT_NAME}. We do not sell any information — from
            this website or from the CRM — to third parties.
          </p>
        </section>
        <section>
          <h2>Data retention and deletion</h2>
          <p>
            We retain information for as long as reasonably necessary to provide the service and maintain accurate
            business records. A travel agency administrator can remove a stored payment card from the CRM at any
            time. To request deletion of information you submitted through this website&apos;s Contact form, or to
            ask a question about data a travel agency has entered about you, use the contact details below.
          </p>
        </section>
        <section>
          <h2>Changes to this policy</h2>
          <p>We may update this policy from time to time. The date above reflects the most recent revision.</p>
        </section>
        <section>
          <h2>Contact</h2>
          <p>
            Questions about this policy, or a request regarding your information, can be sent through our{" "}
            <a href="/contact" className="underline underline-offset-4 hover:text-foreground">
              Contact
            </a>{" "}
            page.
          </p>
        </section>
      </div>
    </div>
  );
}
