import type { MetadataRoute } from "next";
import { resolveBaseUrl } from "@/lib/company-config";
import { PRIVATE_DISALLOW } from "@/lib/marketing/crawl-rules";

// Public marketing routes are crawlable; every authenticated CRM surface is disallowed by prefix (see crawl-rules.ts — robots.txt is
// not a security control).
//
// Preview deployments (VERCEL_ENV=preview) disallow everything and publish no sitemap, so a preview URL can never compete with, or
// be mistaken for, the production site. Production, local and self-hosted builds behave as described above.
export default function robots(): MetadataRoute.Robots {
  if (process.env.VERCEL_ENV === "preview") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  const base = resolveBaseUrl();
  return {
    rules: { userAgent: "*", allow: "/", disallow: PRIVATE_DISALLOW },
    sitemap: `${base}/sitemap.xml`,
  };
}
