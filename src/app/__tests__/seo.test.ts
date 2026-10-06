import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import sitemap from "../sitemap";
import robots from "../robots";
import { PRIVATE_DISALLOW } from "@/lib/marketing/crawl-rules";
import { marketingMetadata, noIndexMetadata, siteJsonLd, softwareJsonLd, pageJsonLd, breadcrumbJsonLd, serializeJsonLd } from "@/lib/marketing/seo";
import { MARKETING_FEATURES } from "@/lib/marketing/features-data";

// Regression coverage for the public SEO / GEO surface: every public page declares unique metadata through the one builder, the sign-in
// page is noindex and out of the sitemap, structured data is valid and contains no sensitive or invented facts, robots.txt covers every
// private route, preview deployments are not indexable, and the public copy about card data is accurate.
const SRC = path.resolve(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(SRC, ...p), "utf-8");
// Developer comments may legitimately explain the separation between the two systems; only what ships in code and copy is checked.
const readCode = (...p: string[]) =>
  read(...p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const PUBLIC_PAGES: { file: string[]; path: string }[] = [
  { file: ["app", "(marketing)", "page.tsx"], path: "/" },
  { file: ["app", "(marketing)", "features", "page.tsx"], path: "/features" },
  { file: ["app", "(marketing)", "about", "page.tsx"], path: "/about" },
  { file: ["app", "(marketing)", "contact", "page.tsx"], path: "/contact" },
  { file: ["app", "(marketing)", "security", "page.tsx"], path: "/security" },
  { file: ["app", "(marketing)", "privacy", "page.tsx"], path: "/privacy" },
  { file: ["app", "(marketing)", "terms", "page.tsx"], path: "/terms" },
];

describe("every public page builds its metadata through the shared builder", () => {
  for (const page of PUBLIC_PAGES) {
    it(`${page.path} uses marketingMetadata with its own canonical path`, () => {
      const code = read(...page.file);
      expect(code).toMatch(/marketingMetadata\(/);
      expect(code).toContain(`path: "${page.path}"`);
      expect(code).not.toMatch(/export const metadata: Metadata = \{/); // no hand-rolled metadata that could drop og:url / canonical
    });
  }

  it("the feature detail pages use it too, with the route's own slug", () => {
    const code = read("app", "(marketing)", "features", "[slug]", "page.tsx");
    expect(code).toMatch(/marketingMetadata\(\{.*path: `\/features\/\$\{feature\.slug\}` \}\)/);
  });
});

describe("marketingMetadata", () => {
  const m = marketingMetadata({ title: "T — Compass Tools", description: "D", path: "/x" });

  it("sets canonical, robots, Open Graph (incl. url / site name) and Twitter from one input", () => {
    expect(m.alternates?.canonical).toBe("/x");
    expect(m.robots).toEqual({ index: true, follow: true });
    expect(m.openGraph).toMatchObject({ title: "T — Compass Tools", description: "D", url: "/x", siteName: "Compass Tools", type: "website" });
    expect(m.twitter).toMatchObject({ title: "T — Compass Tools", description: "D" });
    expect(m.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("uses the product's own generated brand card at a stable URL — never public/logo.png (another business's logo)", () => {
    const og = (m.openGraph?.images as { url: string; width: number; height: number }[])[0];
    expect(og).toMatchObject({ url: "/brand-card.png", width: 1200, height: 630 });
    expect(m.twitter?.images).toEqual(["/brand-card.png"]);
    expect(readCode("lib", "marketing", "seo.ts")).not.toMatch(/logo\.png/);
    expect(read("app", "(marketing)", "brand-card.png", "route.tsx")).toMatch(/renderBrandCard\(\)/);
    expect(readCode("lib", "marketing", "og-card.tsx")).not.toMatch(/logo\.png|business\s*flights|\bBFT\b/i);
  });

  it("noIndexMetadata emits noindex and text-only Open Graph / Twitter (no inherited default image)", () => {
    const n = noIndexMetadata({ title: "Sign In", description: "d", path: "/login" });
    expect(n.robots).toEqual({ index: false, follow: true });
    expect(n.openGraph).toMatchObject({ url: "/login", siteName: "Compass Tools" });
    expect(n.openGraph?.images).toBeUndefined();
    expect(n.twitter?.images).toBeUndefined();
  });

  it("the sign-in page is noindex", () => {
    expect(read("app", "login", "page.tsx")).toMatch(/noIndexMetadata\(/);
  });
});

describe("public titles and descriptions are unique and honest", () => {
  const titles = new Map<string, string>();
  const descriptions = new Map<string, string>();
  const collect = (key: string, code: string) => {
    for (const m of code.matchAll(/title:\s*`([^`]+)`/g)) titles.set(key, m[1]);
    for (const m of code.matchAll(/description:\s*(?:"([^"]+)"|`([^`]+)`)/g)) descriptions.set(key, m[1] ?? m[2]);
  };
  for (const page of PUBLIC_PAGES) collect(page.path, read(...page.file));

  it("no two pages share a description", () => {
    // contact / about keep their description in a named constant (also used for JSON-LD) — resolve it
    for (const [file, key] of [[["app", "(marketing)", "about", "page.tsx"], "/about"], [["app", "(marketing)", "contact", "page.tsx"], "/contact"]] as const) {
      const c = /const \w+_DESCRIPTION =\s*"([^"]+)"/.exec(read(...file));
      expect(c, key).not.toBeNull();
      descriptions.set(key, c![1]);
    }
    const values = [...descriptions.values()];
    expect(new Set(values).size).toBe(values.length);
    for (const feature of MARKETING_FEATURES) expect(values).not.toContain(feature.summary);
    const summaries = MARKETING_FEATURES.map((f) => f.summary);
    expect(new Set(summaries).size).toBe(summaries.length);
  });

  it("descriptions are a sensible length for a snippet", () => {
    for (const [key, d] of descriptions) {
      if (key === "/privacy" || key === "/terms") continue; // template literals interpolating PRODUCT_NAME
      expect(d.length, key).toBeGreaterThan(50);
      expect(d.length, key).toBeLessThanOrEqual(320);
    }
    for (const f of MARKETING_FEATURES) expect(f.summary.length, f.slug).toBeGreaterThan(40);
  });
});

describe("sitemap", () => {
  const entries = sitemap();
  const urls = entries.map((e) => e.url);

  it("lists only canonical public pages: no /login, /api, /quote, cron, health or debug URLs", () => {
    for (const url of urls) {
      const p = new URL(url).pathname;
      expect(p).not.toMatch(/^\/(login|api|quote|access-denied|cron|health|debug|admin)/);
      expect(new URL(url).search).toBe("");
      expect(new URL(url).hash).toBe("");
    }
  });

  it("has no duplicates, a consistent trailing-slash form and a single origin", () => {
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) {
      const u = new URL(url);
      expect(u.pathname.endsWith("/") && u.pathname !== "/", url).toBe(false);
    }
    expect(new Set(urls.map((u) => new URL(u).origin)).size).toBe(1);
  });

  it("does not claim a modification time it does not have", () => {
    for (const e of entries) expect(e.lastModified).toBeUndefined();
  });

  it("the home entry is the bare origin, exactly what the home page canonical resolves to", () => {
    expect(urls[0]).toBe(new URL(urls[0]).origin);
  });
});

describe("robots", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("every top-level directory of the authenticated app is disallowed", () => {
    const crmDir = path.join(SRC, "app", "(crm)");
    const dirs = readdirSync(crmDir).filter((n) => statSync(path.join(crmDir, n)).isDirectory());
    expect(dirs.length).toBeGreaterThan(5);
    for (const dir of dirs) {
      expect(PRIVATE_DISALLOW.some((rule) => `/${dir}`.startsWith(rule.replace(/\/$/, ""))), dir).toBe(true);
    }
  });

  it("disallows the API, the access-denied page and token-gated customer links", () => {
    for (const rule of ["/api/", "/access-denied", "/quote/"]) expect(PRIVATE_DISALLOW).toContain(rule);
  });

  it("never disallows the public pages or the sign-in page (noindex needs the page to be fetchable)", () => {
    for (const p of ["/", "/features", "/about", "/security", "/contact", "/privacy", "/terms", "/login", "/apple-icon", "/brand-card.png"]) {
      expect(PRIVATE_DISALLOW.some((rule) => rule !== "/" && p.startsWith(rule)), p).toBe(false);
    }
  });

  it("production robots allows the site and references the sitemap", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.allow).toBe("/");
    expect(r.sitemap).toMatch(/^https?:\/\/[^/]+\/sitemap\.xml$/);
  });

  it("a preview deployment disallows everything and publishes no sitemap", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.disallow).toBe("/");
    expect(rule.allow).toBeUndefined();
    expect(r.sitemap).toBeUndefined();
  });
});

describe("structured data", () => {
  const all = [
    siteJsonLd(),
    softwareJsonLd(),
    pageJsonLd("AboutPage", { name: "About", description: "d", path: "/about" }),
    pageJsonLd("ContactPage", { name: "Contact", description: "d", path: "/contact" }),
    breadcrumbJsonLd([{ name: "Compass Tools", path: "/" }, { name: "Features", path: "/features" }]),
  ];

  it("serialises to valid JSON that cannot close its own script element", () => {
    const hostile = serializeJsonLd({ name: "</script><script>alert(1)</script>" });
    expect(hostile).not.toContain("</script");
    expect(JSON.parse(hostile).name).toBe("</script><script>alert(1)</script>");
    for (const d of all) expect(() => JSON.parse(serializeJsonLd(d))).not.toThrow();
  });

  it("describes only the site: Organization, WebSite, SoftwareApplication, typed pages and breadcrumbs", () => {
    const graph = (siteJsonLd()["@graph"] as { "@type": string }[]).map((n) => n["@type"]);
    expect(graph).toEqual(["WebSite", "Organization"]);
    expect(softwareJsonLd()["@type"]).toBe("SoftwareApplication");
    expect(softwareJsonLd().applicationCategory).toBe("BusinessApplication");
  });

  it("contains no invented commercial or social-proof facts and nothing about customers, payments or cards", () => {
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/aggregateRating|ratingValue|reviewCount|\"review\"|offers|\"price|priceCurrency|award|telephone|address|employee|foundingDate|sameAs/i);
    expect(text).not.toMatch(/cvv|cvc|card number|payment|booking form|passenger|customer data|password|secret|token/i);
    expect(text).not.toMatch(/business flights|\bBFT\b/i);
  });

  it("every URL is absolute https-or-configured-origin, never localhost-hardcoded to a different host", () => {
    const urls = [...JSON.stringify(all).matchAll(/"(?:url|item|@id)":"([^"]+)"/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(8);
    expect(new Set(urls.map((u) => new URL(u).origin)).size).toBe(1);
  });

  it("the feature pages' breadcrumbs and the marketing layout use the builders", () => {
    expect(read("app", "(marketing)", "features", "[slug]", "page.tsx")).toMatch(/breadcrumbJsonLd\(/);
    expect(read("app", "(marketing)", "layout.tsx")).toMatch(/siteJsonLd\(\)/);
    expect(read("app", "(marketing)", "page.tsx")).toMatch(/softwareJsonLd\(\)/);
    expect(read("app", "(marketing)", "about", "page.tsx")).toMatch(/pageJsonLd\("AboutPage"/);
    expect(read("app", "(marketing)", "contact", "page.tsx")).toMatch(/pageJsonLd\("ContactPage"/);
  });

  it("the authenticated layout renders no structured data", () => {
    expect(read("app", "(crm)", "layout.tsx")).not.toMatch(/ld\+json|JsonLd/);
  });
});

describe("public pages keep the two businesses separate and make no unsupported claims", () => {
  const publicFiles = [
    ...PUBLIC_PAGES.map((p) => p.file),
    ["app", "(marketing)", "layout.tsx"],
    ["app", "(marketing)", "features", "[slug]", "page.tsx"],
    ["lib", "marketing", "features-data.ts"],
    ["lib", "marketing", "seo.ts"],
    ["components", "marketing", "site-header.tsx"],
    ["components", "marketing", "site-footer.tsx"],
  ];

  it("no Business Flights Travel reference in public page source", () => {
    for (const f of publicFiles) expect(readCode(...f), f.join("/")).not.toMatch(/business\s*flights|\bBFT\b/i);
  });

  it("no localhost / preview URL is hardcoded in public SEO code", () => {
    for (const f of [...publicFiles, ["app", "sitemap.ts"], ["app", "robots.ts"], ["lib", "marketing", "crawl-rules.ts"]]) {
      expect(readCode(...f), f.join("/")).not.toMatch(/localhost|127\.0\.0\.1|vercel\.app/i);
    }
  });

  it("never claims PCI DSS compliance or certification", () => {
    for (const f of publicFiles) {
      for (const m of read(...f).matchAll(/.{0,60}\bPCI(?: DSS)?[- ](?:compliant|certified|certification)\b.{0,20}/gi)) {
        expect(m[0], m[0]).toMatch(/\b(not|never|nor|no)\b/i);
      }
    }
  });

  it("the privacy page no longer says the security code is never collected or stored, and states the 24-hour limit", () => {
    const privacy = read("app", "(marketing)", "privacy", "page.tsx").replace(/\s+/g, " ");
    expect(privacy).not.toMatch(/never requested, collected, or stored/i);
    expect(privacy).toMatch(/no later than 24 hours after the customer signs the booking form/);
    expect(privacy).toMatch(/We do not claim any particular payment-industry certification/);
  });

  it("the security page describes encrypted card data accurately instead of 'No stored card numbers'", () => {
    const security = read("app", "(marketing)", "security", "page.tsx").replace(/\s+/g, " ");
    expect(security).not.toMatch(/No stored card numbers/);
    expect(security).toMatch(/encrypted before it is stored/);
    expect(security).toMatch(/never longer than 24 hours after the booking form is signed/);
  });

  it("the privacy page's 'Last updated' is a fixed date, not the time of the request", () => {
    expect(read("app", "(marketing)", "privacy", "page.tsx")).not.toMatch(/Last updated: \{new Date\(\)/);
  });
});
