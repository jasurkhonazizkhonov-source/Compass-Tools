# SEO, discoverability and structured data

Scope: the **public marketing site** only (`src/app/(marketing)`). The authenticated CRM, token-gated customer pages and the API are never
indexable and are never described in metadata, structured data or the sitemap.

## Where things live

| Concern | Location |
| --- | --- |
| Page metadata (title, description, canonical, robots, Open Graph, Twitter) | `marketingMetadata()` in `src/lib/marketing/seo.ts` — every public page calls it; nobody hand-writes `metadata` for a public page |
| Non-indexable public-adjacent page (sign-in) | `noIndexMetadata()` in the same file |
| JSON-LD builders | `siteJsonLd`, `softwareJsonLd`, `pageJsonLd`, `breadcrumbJsonLd`, `serializeJsonLd` in `seo.ts`; rendered with `src/components/marketing/json-ld.tsx` |
| Sitemap | `src/app/sitemap.ts` → `/sitemap.xml` |
| robots.txt | `src/app/robots.ts` → `/robots.txt`; private prefixes in `src/lib/marketing/crawl-rules.ts` |
| Origin used in canonicals / sitemap / JSON-LD | `resolveBaseUrl()` in `src/lib/company-config.ts` (`APP_BASE_URL` → `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_URL` → `http://localhost:3000`) |
| Regression tests | `src/app/__tests__/seo.test.ts`, `src/app/__tests__/sitemap.test.ts` |

## Canonical / indexability strategy

* Canonical URLs are **relative paths** (`/about`) resolved by Next.js against `metadataBase` (= `resolveBaseUrl()`), so production canonicalises
  to the production HTTPS origin while preview and local builds canonicalise to their own origin — nothing is hardcoded.
* No trailing slash on any canonical; the home page is the bare origin (`https://host`), and the sitemap uses exactly that form. No query-string
  variants are ever canonical.
* Statically rendered pages bake the origin in **at build time**, so a build must run with `APP_BASE_URL` (or Vercel's production URL variables)
  set; a local build without it canonicalises to `http://localhost:3000`.
* Open Graph / Twitter use the existing `public/logo.png` (1163×488) as a relative URL. A page-level `openGraph` **replaces** (does not merge
  with) the root layout's, which is why the builder always sets `url`, `siteName`, `locale` and `type` itself.
* Public pages: `index, follow`. `/login`: `noindex, follow` — it stays crawlable (not in robots.txt) so crawlers can read the directive, and
  it is absent from the sitemap.
* Preview deployments (`VERCEL_ENV=preview`): `robots.txt` is `Disallow: /` with no sitemap.

## Sitemap

Contains only the public, indexable, canonical HTTPS URLs: `/`, `/features`, `/features/<slug>` (one per entry in
`src/lib/marketing/features-data.ts`), `/about`, `/security`, `/contact`, `/privacy`, `/terms`. It deliberately excludes `/login`, every CRM
route, `/quote/…` and `/booking…` customer links, `/api/*`, cron, health and any debug endpoint. There is no `lastModified`: the pages have no
real modification date, and "now" on every request would be misleading.

A new public page needs: an entry in `staticRoutes` in `sitemap.ts`, a `marketingMetadata()` call, and a row in `PUBLIC_PAGES` in `seo.test.ts`.

## robots.txt

Allows the public site, disallows the private prefixes in `crawl-rules.ts`, and references `<origin>/sitemap.xml`. A test fails if a new
top-level directory is added under `src/app/(crm)` without being added to that list. **robots.txt is not a security control** — it asks
well-behaved crawlers to stay away; access to those routes is enforced by the session gate (`src/proxy.ts`) and per-action authorization.

## Structured data (JSON-LD)

Only facts the public site itself states: product name, origin, logo, one-line description, page type and breadcrumbs.

* every public page (marketing layout): `WebSite` + `Organization` (`@graph`, referenced by `@id`)
* home: `SoftwareApplication` (`applicationCategory: BusinessApplication`; no price, rating, review or platform claim)
* `/about`: `AboutPage`; `/contact`: `ContactPage`
* `/features`, `/features/<slug>`: `BreadcrumbList`

Do **not** add ratings, reviews, prices, awards, addresses, phone numbers, staff, certifications or `sameAs` links unless they are real and
stated on the site. Nothing about customers, bookings, payments, cards or internal systems may appear in structured data; the tests scan for
that. `serializeJsonLd` escapes `<` so a value can never close the script element.

## Copy conventions (GEO)

Public pages state plainly what Compass Tools is, who it is for, what it provides and how to contact it (the About page answers those four
questions under their own headings and links to each feature page). Claims must be supported by `features-data.ts` or by the implemented
product. Compass Tools and the separate travel-agency website are different businesses and systems: **no public page, metadata or structured
data may mention the other one** (tests enforce this on the source). The site makes **no PCI DSS compliance or certification claim**; the
Security and Privacy pages describe the application-level controls only.

## Not covered / manual

* Submitting the sitemap in Google Search Console / Bing Webmaster Tools and verifying the property.
* The Terms page's "Last updated" line is still computed from the current date — a business decision (a legal document's date should be
  the date it was actually revised).
