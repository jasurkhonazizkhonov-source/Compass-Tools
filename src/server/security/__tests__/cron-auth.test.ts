import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hasValidCronSecret, rejectUnauthorizedCron } from "../cron-auth";

// Every /api/cron/* endpoint (tasks + card retention, sequences that send real e-mail, leads, CVV cleanup) is gated by this one function. It must FAIL CLOSED in a production-class
// environment: no secret configured means the endpoint is disabled (503), never open. This had no direct test before 2026-11-23.
const SECRET = "unit-test-cron-secret-0123456789-abcdefghij"; // throwaway
const req = (authorization?: string) => new Request("https://example.test/api/cron/sequences", { headers: authorization ? { authorization } : {} });
const status = async (r: Response | null) => (r ? r.status : null);

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("APP_ENV", "");
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

describe("rejectUnauthorizedCron: production-class (fails closed)", () => {
  it("no secret configured: the endpoint is DISABLED with 503 - whatever the request carries", async () => {
    expect(await status(rejectUnauthorizedCron(req()))).toBe(503);
    expect(await status(rejectUnauthorizedCron(req("Bearer anything")))).toBe(503);
    expect(await status(rejectUnauthorizedCron(req("Bearer ")))).toBe(503);
  });

  it("a whitespace-only secret counts as no secret", async () => {
    vi.stubEnv("CRON_SECRET", "   ");
    expect(await status(rejectUnauthorizedCron(req("Bearer    ")))).toBe(503);
  });

  it("secret configured: no header, a wrong secret, the secret without 'Bearer', a different scheme and a prefix of the secret are all 401", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const header of [undefined, `Bearer wrong-${SECRET}`, SECRET, `Basic ${SECRET}`, `Bearer ${SECRET.slice(0, -1)}`, `bearer ${SECRET}`, `Bearer ${SECRET}x`]) { // (a trailing space is not a case: Headers trims header values before they reach the function)
      expect(await status(rejectUnauthorizedCron(req(header))), String(header)).toBe(401);
    }
  });

  it("secret configured and presented: allowed (null)", () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(rejectUnauthorizedCron(req(`Bearer ${SECRET}`))).toBeNull();
  });

  it("a Vercel preview deployment is production-class too", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await status(rejectUnauthorizedCron(req()))).toBe(503);
  });

  it("answers are never cached and never echo the secret", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const denied = rejectUnauthorizedCron(req("Bearer nope"))!;
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(await denied.text()).not.toContain(SECRET);
  });
});

describe("rejectUnauthorizedCron: local development", () => {
  it("open when no secret is set (so curl and the in-process poller work), enforced as soon as one is", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(rejectUnauthorizedCron(req())).toBeNull();
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(rejectUnauthorizedCron(req())!.status).toBe(401);
    expect(rejectUnauthorizedCron(req(`Bearer ${SECRET}`))).toBeNull();
  });
});

describe("hasValidCronSecret (gates the detailed /api/health report)", () => {
  it("is false without a configured secret even in development, and only true for the exact bearer value", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(hasValidCronSecret(req())).toBe(false);
    expect(hasValidCronSecret(req("Bearer "))).toBe(false);
    vi.stubEnv("CRON_SECRET", SECRET);
    expect(hasValidCronSecret(req())).toBe(false);
    expect(hasValidCronSecret(req("Bearer nope"))).toBe(false);
    expect(hasValidCronSecret(req(`Bearer ${SECRET}`))).toBe(true);
  });
});
