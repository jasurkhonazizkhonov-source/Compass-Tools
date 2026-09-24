import { describe, it, expect } from "vitest";
import sitemap from "../sitemap";
import robots from "../robots";
import { MARKETING_FEATURES } from "@/lib/marketing/features-data";

// Regression coverage for Part 4 (SEO): the sitemap must list every public
// marketing route and must NEVER list an authenticated CRM route — a
// crawler discovering /leads or /dashboard through the sitemap would be a
// real information-disclosure/indexing risk, not just a cosmetic issue.
const PRIVATE_CRM_PREFIXES = [
  "/dashboard",
  "/leads",
  "/contacts",
  "/quotes",
  "/bookings",
  "/accounts",
  "/sequences",
  "/tasks",
  "/users",
  "/company",
  "/get-in-touch",
  "/subscriptions",
  "/commissions",
  "/salesboard",
];

describe("sitemap.ts", () => {
  it("includes every public marketing route", () => {
    const urls = sitemap().map((entry) => new URL(entry.url).pathname);
    expect(urls).toContain("/");
    expect(urls).toContain("/features");
    expect(urls).toContain("/about");
    expect(urls).toContain("/security");
    expect(urls).toContain("/contact");
    expect(urls).toContain("/privacy");
    expect(urls).toContain("/terms");
    expect(urls).toContain("/login");
  });

  it("includes every feature slug page, and none are missing or extra", () => {
    const urls = sitemap().map((entry) => new URL(entry.url).pathname);
    const featureUrls = urls.filter((u) => u.startsWith("/features/"));
    expect(featureUrls.sort()).toEqual(MARKETING_FEATURES.map((f) => `/features/${f.slug}`).sort());
  });

  it("never lists an authenticated CRM route", () => {
    const urls = sitemap().map((entry) => new URL(entry.url).pathname);
    for (const url of urls) {
      for (const prefix of PRIVATE_CRM_PREFIXES) {
        expect(url === prefix || url.startsWith(`${prefix}/`)).toBe(false);
      }
    }
  });

  it("every URL is built from the resolved canonical origin, never hardcoded to a different host", () => {
    const urls = sitemap().map((entry) => entry.url);
    const origins = new Set(urls.map((u) => new URL(u).origin));
    expect(origins.size).toBe(1);
  });
});

describe("robots.ts", () => {
  it("disallows every authenticated CRM route prefix", () => {
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    for (const prefix of PRIVATE_CRM_PREFIXES) {
      expect(disallow).toContain(prefix);
    }
  });

  it("allows the public site by default and points at the real sitemap URL", () => {
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    expect(rule.allow).toBe("/");
    expect(result.sitemap).toMatch(/\/sitemap\.xml$/);
  });
});
