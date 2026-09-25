import type { MetadataRoute } from "next";
import { resolveBaseUrl } from "@/lib/company-config";

// Public marketing routes are crawlable; every authenticated CRM surface is
// disallowed by prefix so no private route is ever accidentally indexed.
export default function robots(): MetadataRoute.Robots {
  const base = resolveBaseUrl();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/access-denied",
        "/dashboard",
        "/accounts",
        "/bookings",
        "/commissions",
        "/company",
        "/contacts",
        "/leads",
        "/quotes",
        "/salesboard",
        "/sequences",
        "/subscriptions",
        "/tasks",
        "/users",
        "/get-in-touch",
        "/crm-inquiries",
        // Customer-facing but token-gated (a unique, unguessable link per
        // quote/booking) — never something a crawler should index either.
        "/cvv-recollection",
        "/quote/",
      ],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
