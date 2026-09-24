import type { Metadata } from "next";
import { ShieldCheck, Lock, KeyRound, Server } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/company-config";

export const metadata: Metadata = {
  title: `Security — ${PRODUCT_NAME}`,
  description: "How Compass Tools protects account access and customer data.",
  alternates: { canonical: "/security" },
};

// Factual descriptions only — every statement below reflects an actual,
// verified implementation detail of this CRM (server-side Google identity
// verification, encrypted OAuth tokens, server-enforced role checks, no
// raw payment card storage). Deliberately does NOT claim any third-party
// certification, compliance framework, or uptime guarantee that has not
// been independently verified — see this page's own content rules.
const PRACTICES = [
  {
    icon: ShieldCheck,
    title: "Verified sign-in",
    body: "Access requires signing in with Google. Every credential is verified server-side before a session is ever created — client-supplied identity is never trusted on its own.",
  },
  {
    icon: KeyRound,
    title: "Encrypted credentials",
    body: "OAuth refresh tokens used to send email are stored encrypted, never in plain text, and are never exposed to the browser or logged.",
  },
  {
    icon: Lock,
    title: "Role-based access",
    body: "What a team member can see and do is determined server-side by their assigned role — never by anything the browser sends. Admin-only areas are enforced on every request, not just hidden from navigation.",
  },
  {
    icon: Server,
    title: "No stored card numbers",
    body: "Customer payment information is never stored as raw card data. Booking forms are served over HTTPS in production.",
  },
];

export default function SecurityPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
      <h1 className="text-4xl font-semibold tracking-tight text-foreground">Security</h1>
      <p className="mt-4 text-muted-foreground">
        A practical summary of how {PRODUCT_NAME} protects account access and customer information. This page
        describes how the system is actually built — it does not claim any third-party certification.
      </p>

      <div className="mt-12 grid gap-6 sm:grid-cols-2">
        {PRACTICES.map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-xl border bg-background p-6 shadow-sm">
            <Icon className="h-5 w-5 text-[#1c3a5e] dark:text-[#d4a24e]" aria-hidden />
            <h2 className="mt-3 text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>

      <p className="mt-10 text-sm text-muted-foreground">
        Questions about a specific security practice? <a href="/contact" className="underline underline-offset-4 hover:text-foreground">Get in touch</a>.
      </p>
    </div>
  );
}
