import type { Metadata } from "next";
import { PRODUCT_NAME, resolveBaseUrl } from "@/lib/company-config";

// One place that builds the metadata and structured data of every PUBLIC marketing page, so title / description / canonical / Open
// Graph / Twitter can never drift apart or be forgotten on a new page (a page-level `openGraph` REPLACES the root layout's rather than
// merging with it, which is how pages used to lose og:url / og:site_name).
//
// Only facts the public site itself already states go in here: the product name, its origin and its own mark. Nothing about customers,
// bookings, payments, staff or any internal system, and no claim (rating, price, certification, address …) the repository cannot
// substantiate. Relative paths are resolved against `metadataBase` (resolveBaseUrl()) by Next.js, so production, preview and local
// builds each canonicalise to their own configured origin.

export const SITE_DESCRIPTION = "Compass Tools is a CRM built for travel agencies to manage leads, quotes, bookings, and customer communication in one place.";
// The product's own mark is the generated app icon (src/app/apple-icon.tsx, 180×180). Do NOT use public/logo.png here: that file is the
// default travel agency's own logo, a different business from the product (the Open Graph / Twitter card image is generated from the
// product's mark, served at /brand-card.png by src/app/(marketing)/brand-card.png/route.tsx).
const LOGO = { path: "/apple-icon", width: 180, height: 180 };
export const OG_SIZE = { width: 1200, height: 630 };
export const OG_ALT = `${PRODUCT_NAME} — CRM for travel agencies`;
const CARD = { url: "/brand-card.png", ...OG_SIZE, alt: OG_ALT };

export function marketingMetadata(input: { title: string; description: string; path: string; index?: boolean }): Metadata {
  const { title, description, path, index = true } = input;
  return {
    title,
    description,
    alternates: { canonical: path },
    robots: index ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: { title, description, url: path, siteName: PRODUCT_NAME, locale: "en_US", type: "website", images: [CARD] },
    twitter: { card: "summary_large_image", title, description, images: [CARD.url] },
  };
}

/**
 * A page that must never appear in search results (sign-in, errors). Still crawlable so the directive can be read. It declares its own
 * text-only Open Graph / Twitter metadata (no image) so a shared link never falls back to the root layout's default image.
 */
export function noIndexMetadata(input: { title: string; description: string; path: string }): Metadata {
  const { title, description, path } = input;
  return {
    title,
    description,
    alternates: { canonical: path },
    robots: { index: false, follow: true },
    openGraph: { title, description, url: path, siteName: PRODUCT_NAME, locale: "en_US", type: "website" },
    twitter: { card: "summary", title, description },
  };
}

// ── structured data (schema.org JSON-LD) ──────────────────────────────────────────────────────────────────────────────────────
const abs = (path: string) => `${resolveBaseUrl()}${path === "/" ? "" : path}`;

/** The site-wide entities, referenced from every page by @id. Name, URL and logo only — nothing invented. */
export function siteJsonLd() {
  const base = resolveBaseUrl();
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "@id": `${base}/#website`, name: PRODUCT_NAME, url: base, publisher: { "@id": `${base}/#organization` } },
      { "@type": "Organization", "@id": `${base}/#organization`, name: PRODUCT_NAME, url: base, logo: { "@type": "ImageObject", url: `${base}${LOGO.path}`, width: LOGO.width, height: LOGO.height } },
    ],
  };
}

/** The home page describes the product itself. Category and description only: no price, rating, review or platform claims. */
export function softwareJsonLd(description: string = SITE_DESCRIPTION) {
  const base = resolveBaseUrl();
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${base}/#software`,
    name: PRODUCT_NAME,
    url: base,
    description,
    applicationCategory: "BusinessApplication",
    publisher: { "@id": `${base}/#organization` },
  };
}

/** A typed page (AboutPage / ContactPage) that belongs to the site entity above. */
export function pageJsonLd(type: "AboutPage" | "ContactPage" | "WebPage", input: { name: string; description: string; path: string }) {
  const base = resolveBaseUrl();
  return {
    "@context": "https://schema.org",
    "@type": type,
    "@id": `${abs(input.path)}#webpage`,
    name: input.name,
    description: input.description,
    url: abs(input.path),
    isPartOf: { "@id": `${base}/#website` },
  };
}

/** Home › Features › Lead Management — mirrors the real route hierarchy; every item resolves to an existing public page. */
export function breadcrumbJsonLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({ "@type": "ListItem", position: i + 1, name: item.name, item: abs(item.path) })),
  };
}

/** JSON for a <script type="application/ld+json">: `<` is escaped so no value can ever close the script element. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
