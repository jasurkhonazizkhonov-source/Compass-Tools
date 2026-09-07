import type { Metadata } from "next";
import { CustomerThemeProvider } from "@/components/customer/customer-theme-provider";

// Pass 13 §38/§40 — this layout sits ABOVE the [token] dynamic segment, so
// it cannot resolve which Company owns a specific quote (Next.js layout
// params only include segments at or above the layout itself) — this
// static metadata is therefore a neutral, brand-agnostic fallback, shown
// only until a child page's own generateMetadata (see quote/[token]/page.tsx)
// resolves the real per-company name and overrides it. Deliberately does
// NOT mention the internal CRM product name (PRODUCT_NAME/"Compass Tools")
// anywhere — a customer must never see internal CRM branding in the
// browser tab title, exactly the same "no internal branding" rule that
// already applies to every customer-facing page and email body.
export const metadata: Metadata = {
  title: "Your Flight Quote",
  description: "Review your personalized flight quote.",
};

export default function QuoteLayout({ children }: { children: React.ReactNode }) {
  return <CustomerThemeProvider>{children}</CustomerThemeProvider>;
}
