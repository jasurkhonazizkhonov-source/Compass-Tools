import { describe, it, expect } from "vitest";
import { arrivedViaPublicEdge, authenticateWebsiteApi, isWebsiteApiConfigured, publicRouteAllowed, websiteApiCompanyId } from "../website-api-auth";

// Throwaway test values - not secrets.
const KEY_A = "a".repeat(40);
const KEY_B = "b".repeat(40);
const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });

describe("website API credential", () => {
  it("is not configured without a usable key, and says so instead of accepting anything", () => {
    expect(isWebsiteApiConfigured({})).toBe(false);
    expect(authenticateWebsiteApi(bearer(KEY_A), {})).toBe("not_configured");
    expect(authenticateWebsiteApi(new Headers(), {})).toBe("not_configured");
  });

  it("treats a short key as not configured (a guessable value is worse than a disabled API)", () => {
    expect(isWebsiteApiConfigured({ WEBSITE_API_KEY: "short" })).toBe(false);
    expect(isWebsiteApiConfigured({ WEBSITE_API_KEY: "x".repeat(31) })).toBe(false);
    expect(isWebsiteApiConfigured({ WEBSITE_API_KEY: "x".repeat(32) })).toBe(true);
    expect(authenticateWebsiteApi(bearer("short"), { WEBSITE_API_KEY: "short" })).toBe("not_configured");
  });

  it("accepts exactly the configured key", () => {
    const env = { WEBSITE_API_KEY: KEY_A };
    expect(authenticateWebsiteApi(bearer(KEY_A), env)).toBe("ok");
    expect(authenticateWebsiteApi(bearer(KEY_B), env)).toBe("unauthorized");
    expect(authenticateWebsiteApi(bearer(KEY_A + "x"), env)).toBe("unauthorized");
    expect(authenticateWebsiteApi(bearer(KEY_A.slice(0, -1)), env)).toBe("unauthorized");
  });

  it("rejects a missing, empty, wrongly-schemed or oversized Authorization header", () => {
    const env = { WEBSITE_API_KEY: KEY_A };
    expect(authenticateWebsiteApi(new Headers(), env)).toBe("unauthorized");
    expect(authenticateWebsiteApi(new Headers({ authorization: "" }), env)).toBe("unauthorized");
    expect(authenticateWebsiteApi(new Headers({ authorization: "Bearer" }), env)).toBe("unauthorized");
    expect(authenticateWebsiteApi(new Headers({ authorization: KEY_A }), env)).toBe("unauthorized"); // no scheme
    expect(authenticateWebsiteApi(new Headers({ authorization: `Basic ${KEY_A}` }), env)).toBe("unauthorized");
    expect(authenticateWebsiteApi(new Headers({ authorization: `Bearer ${KEY_A} extra` }), env)).toBe("unauthorized");
    expect(authenticateWebsiteApi(bearer("z".repeat(5000)), env)).toBe("unauthorized");
    // the key anywhere else is not authentication
    expect(authenticateWebsiteApi(new Headers({ "x-api-key": KEY_A }), env)).toBe("unauthorized");
  });

  it("the scheme name is case-insensitive, the key is case-sensitive", () => {
    const env = { WEBSITE_API_KEY: "AbCd".repeat(10) };
    expect(authenticateWebsiteApi(new Headers({ authorization: `bearer ${"AbCd".repeat(10)}` }), env)).toBe("ok");
    expect(authenticateWebsiteApi(new Headers({ authorization: `Bearer ${"abcd".repeat(10)}` }), env)).toBe("unauthorized");
  });

  it("supports rotation: both keys work at once, and a removed key stops working", () => {
    const both = { WEBSITE_API_KEY: KEY_A, WEBSITE_API_KEY_NEXT: KEY_B };
    expect(authenticateWebsiteApi(bearer(KEY_A), both)).toBe("ok");
    expect(authenticateWebsiteApi(bearer(KEY_B), both)).toBe("ok");
    const after = { WEBSITE_API_KEY: KEY_B };
    expect(authenticateWebsiteApi(bearer(KEY_A), after)).toBe("unauthorized");
    expect(authenticateWebsiteApi(bearer(KEY_B), after)).toBe("ok");
    // only the NEXT key set (during the very first step of a rotation) also works
    expect(authenticateWebsiteApi(bearer(KEY_B), { WEBSITE_API_KEY_NEXT: KEY_B })).toBe("ok");
  });

  it("surrounding whitespace in the configured value (a pasted .env line) is ignored", () => {
    expect(authenticateWebsiteApi(bearer(KEY_A), { WEBSITE_API_KEY: `  ${KEY_A}\n` })).toBe("ok");
  });

  it("other secrets are not accepted as the website key", () => {
    const env = { WEBSITE_API_KEY: KEY_A, CRON_SECRET: KEY_B, LEAD_INGEST_SECRET: "c".repeat(40) };
    expect(authenticateWebsiteApi(bearer(KEY_B), env)).toBe("unauthorized");
    expect(authenticateWebsiteApi(bearer("c".repeat(40)), env)).toBe("unauthorized");
  });

  it("the company is fixed by configuration, with the seeded single tenant as the default", () => {
    expect(websiteApiCompanyId({})).toBe("default-company");
    expect(websiteApiCompanyId({ WEBSITE_API_COMPANY_ID: "  " })).toBe("default-company");
    expect(websiteApiCompanyId({ WEBSITE_API_COMPANY_ID: " acme " })).toBe("acme");
  });

  it("recognises a request that came through Cloudflare's public edge, and only opens that door on an explicit setting", () => {
    expect(arrivedViaPublicEdge(new Headers())).toBe(false);
    expect(arrivedViaPublicEdge(new Headers({ "cf-ray": "abc-FRA" }))).toBe(true);
    expect(arrivedViaPublicEdge(new Headers({ "cf-connecting-ip": "203.0.113.9" }))).toBe(true);
    expect(arrivedViaPublicEdge(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe(false); // not a Cloudflare marker
    expect(publicRouteAllowed({})).toBe(false);
    expect(publicRouteAllowed({ WEBSITE_API_ALLOW_PUBLIC_ROUTE: "false" })).toBe(false);
    expect(publicRouteAllowed({ WEBSITE_API_ALLOW_PUBLIC_ROUTE: "1" })).toBe(false);
    expect(publicRouteAllowed({ WEBSITE_API_ALLOW_PUBLIC_ROUTE: "TRUE" })).toBe(true);
  });
});
