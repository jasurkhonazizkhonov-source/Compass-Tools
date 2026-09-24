import type { MetadataRoute } from "next";
import { resolveBaseUrl } from "@/lib/company-config";
import { MARKETING_FEATURES } from "@/lib/marketing/features-data";

// Lists ONLY the public marketing routes. Authenticated CRM routes
// (/dashboard, /leads, /quotes, /get-in-touch, etc.) are intentionally
// excluded — they require sign-in and must never be surfaced to crawlers.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = resolveBaseUrl();
  const staticRoutes = ["/", "/features", "/about", "/security", "/contact", "/privacy", "/terms", "/login"];
  const featureRoutes = MARKETING_FEATURES.map((f) => `/features/${f.slug}`);

  return [...staticRoutes, ...featureRoutes].map((path) => ({
    url: `${base}${path}`,
    lastModified: new Date(),
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.7,
  }));
}
