import type { MetadataRoute } from "next";
import { resolveBaseUrl } from "@/lib/company-config";
import { MARKETING_FEATURES } from "@/lib/marketing/features-data";

// Lists ONLY public, indexable, canonical marketing URLs. Everything else is
// intentionally absent: authenticated CRM routes (/dashboard, /leads, /quotes,
// /get-in-touch, …), token-gated customer pages (/quote/…), the sign-in page
// (/login, noindex), /api/*, cron and health endpoints. It is not a security
// control — those routes are protected by the session gate — it only keeps
// crawlers from being pointed at them.
//
// No `lastModified`: the pages have no real modification date to report, and
// "now" on every request would tell crawlers everything changed every time.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = resolveBaseUrl();
  const staticRoutes = ["/", "/features", "/about", "/security", "/contact", "/privacy", "/terms"];
  const featureRoutes = MARKETING_FEATURES.map((f) => `/features/${f.slug}`);

  return [...staticRoutes, ...featureRoutes].map((path) => ({
    // The home page's canonical renders without a trailing slash ("https://host"), so the sitemap entry is the bare origin to match it.
    url: path === "/" ? base : `${base}${path}`,
    changeFrequency: path === "/" ? "weekly" : "monthly",
    priority: path === "/" ? 1 : 0.7,
  }));
}
