import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { resolveBaseUrl } from "@/lib/company-config";

// The first production upload failed because the R2 bucket's CORS policy listed https://compass-tools.com while the site is served from
// https://www.compass-tools.com (the browser's Origin header). The bucket lives in Cloudflare, so the repo can't enforce it — but the
// documented policy (the one operators copy) must name the real production origin, stay narrow, and say so.
const PRODUCTION_ORIGIN = "https://www.compass-tools.com";
const doc = readFileSync(path.resolve(__dirname, "..", "..", "..", "..", "docs", "LEAD_ATTACHMENTS.md"), "utf-8");

describe("documented R2 CORS policy", () => {
  const block = /```json\s*([\s\S]*?)```/.exec(doc)?.[1] ?? "";
  const rules = JSON.parse(block) as { AllowedOrigins: string[]; AllowedMethods: string[]; AllowedHeaders: string[]; MaxAgeSeconds: number }[];

  it("allows exactly the production origin — www, https, no path, no wildcard", () => {
    expect(rules).toHaveLength(1);
    expect(rules[0].AllowedOrigins).toEqual([PRODUCTION_ORIGIN]);
    expect(rules[0].AllowedOrigins.join(" ")).not.toContain("*");
    expect(rules[0].AllowedOrigins).not.toContain("https://compass-tools.com");
  });

  it("permits only what the upload needs: PUT with content-type", () => {
    expect(rules[0].AllowedMethods).toEqual(["PUT"]);
    expect(rules[0].AllowedHeaders).toEqual(expect.arrayContaining(["content-type"]));
    expect(rules[0].AllowedHeaders).not.toContain("*");
    expect(rules[0].MaxAgeSeconds).toBeLessThanOrEqual(86400);
  });

  it("explains the www-vs-apex mistake and which setting fixes which symptom", () => {
    expect(doc).toContain(`**The production origin is \`${PRODUCTION_ORIGIN}\`**`);
    expect(doc).toMatch(/lists only `https:\/\/compass-tools\.com`/);
    expect(doc).toMatch(/CORS \/ preflight failure.*R2 bucket CORS/);
    expect(doc).toMatch(/`PUT` returns 403.*R2 token/);
    expect(doc).toMatch(/violates Content Security Policy.*redeploy/);
    expect(doc).toMatch(/`PUT` succeeds but the file is rejected/);
  });

  it("matches the application's own production origin", () => {
    const saved = { ...process.env };
    try {
      delete process.env.APP_BASE_URL;
      delete process.env.VERCEL_URL;
      process.env.VERCEL_PROJECT_PRODUCTION_URL = "www.compass-tools.com";
      expect(resolveBaseUrl()).toBe(PRODUCTION_ORIGIN);
    } finally {
      process.env = saved;
    }
  });
});
