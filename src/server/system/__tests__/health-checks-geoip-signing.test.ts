import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The two System Health rows added on 2026-11-22: the local IP-geolocation database and the website request-signing mode. Each state of each row is a test; the GeoIP state is the
// SAME function /api/health reports (stubbed here), and nothing in either row may carry a path, a secret or an address.

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const status = vi.fn();
vi.mock("@/server/geo/ip-geolocation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/geo/ip-geolocation")>()), getGeoIpDatabaseStatus: (...a: unknown[]) => status(...a) }));

import { checkGeoIpDatabase, checkWebsiteSigning } from "../health-checks";

const SECRET = "unit-test-ingest-secret-0123456789-abcdefghijkl"; // throwaway
const fact = (r: { facts?: Array<{ label: string; value: string }> }, label: string) => r.facts?.find((f) => f.label === label)?.value;

beforeEach(() => {
  status.mockReset();
  vi.stubEnv("LEAD_INGEST_SECRET", "");
  vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "");
  vi.stubEnv("APP_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

describe("System Health - IP geolocation database", () => {
  it("ready: healthy, says city-level locations are available and that they are estimates; names the product and build date", async () => {
    status.mockResolvedValue({ state: "ready", databaseType: "DBIP-City-Lite", builtAt: new Date("2026-11-01T00:00:00Z"), ageDays: 21 });
    const r = await checkGeoIpDatabase();
    expect(r.state).toBe("HEALTHY");
    expect(r.summary).toMatch(/City-level approximate locations/);
    expect(r.summary).toMatch(/never exact/);
    expect(fact(r, "State")).toBe("Ready");
    expect(fact(r, "Database")).toBe("DBIP-City-Lite");
    expect(fact(r, "Built")).toBe("2026-11-01 (21 days ago)");
  });

  it("not installed: it is OPTIONAL, so HEALTHY with a plain note (the catalogue's rule) - and the note says locations are country-level and where to read how to enable city level", async () => {
    status.mockResolvedValue({ state: "missing" });
    const r = await checkGeoIpDatabase();
    expect(r.state).toBe("HEALTHY");
    expect(r.classification).toBe("informational");
    expect(r.summary).toMatch(/No IP geolocation database is installed \(optional\)/);
    expect(r.summary).toMatch(/country-level at best/);
    expect(r.summary).toContain("docs/GEOIP.md section 2b");
    expect(fact(r, "State")).toBe("Not installed");
  });

  it("out of date: a WARNING that asks for a manual update, says it is still used, and gives the age and the limit", async () => {
    status.mockResolvedValue({ state: "stale", databaseType: "DBIP-City-Lite", builtAt: new Date("2026-06-01T00:00:00Z"), ageDays: 174 });
    const r = await checkGeoIpDatabase();
    expect(r.state).toBe("WARNING");
    expect(r.classification).toBe("manual_action");
    expect(r.summary).toMatch(/174 days old \(limit 90\)/);
    expect(r.summary).toMatch(/still used/);
    expect(r.action).toMatch(/geoip-update/);
  });

  it("unusable: a WARNING (something that was set up stopped working); locations fall back to country level", async () => {
    status.mockResolvedValue({ state: "unusable" });
    const r = await checkGeoIpDatabase();
    expect(r.state).toBe("WARNING");
    expect(r.summary).toMatch(/cannot be used/);
    expect(r.summary).toMatch(/country-level/);
    expect(fact(r, "State")).toBe("Unusable");
  });

  it("a failure of the status call is one UNKNOWN row (never an unhandled error, never a guess)", async () => {
    status.mockRejectedValue(new Error("boom"));
    expect((await checkGeoIpDatabase()).state).toBe("UNKNOWN");
  });

  it("no row ever carries a file path or a lookup record", async () => {
    status.mockResolvedValue({ state: "ready", databaseType: "DBIP-City-Lite", builtAt: new Date("2026-11-01T00:00:00Z"), ageDays: 3 });
    expect(JSON.stringify(await checkGeoIpDatabase())).not.toMatch(/\.mmdb|\/var\/|\/srv\/|[A-Za-z]:\\\\/);
  });
});

describe("System Health - Website request signing", () => {
  it("strict mode: healthy, and says what is refused", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true");
    const r = await checkWebsiteSigning();
    expect(r.state).toBe("HEALTHY");
    expect(r.summary).toMatch(/Unsigned, replayed and modified requests are refused/);
    expect(fact(r, "Strict mode (WEBSITE_SIGNATURE_REQUIRED)")).toBe("On");
  });

  it("transitional (secret set, strict mode off) in production: a WARNING that asks for exactly one manual step - the documented switch, after the website is live", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
    const r = await checkWebsiteSigning();
    expect(r.state).toBe("WARNING");
    expect(r.classification).toBe("manual_action");
    expect(r.summary).toMatch(/WITHOUT a signature is still accepted/);
    expect(r.action).toContain("WEBSITE_SIGNATURE_REQUIRED=true");
    expect(r.action).toMatch(/after the updated website is live/i);
    expect(fact(r, "Strict mode (WEBSITE_SIGNATURE_REQUIRED)")).toBe("Off");
  });

  it("no secret in production: a WARNING that says requests cannot be authenticated and no visitor IP is recorded", async () => {
    const r = await checkWebsiteSigning();
    expect(r.state).toBe("WARNING");
    expect(r.summary).toMatch(/cannot be authenticated/);
    expect(fact(r, "Shared signing secret")).toBe("Missing");
  });

  it("the strict switch alone (no secret) is NOT strict: nothing could be verified, and the row says so", async () => {
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true");
    const r = await checkWebsiteSigning();
    expect(r.state).toBe("WARNING");
    expect(fact(r, "Shared signing secret")).toBe("Missing");
  });

  it("outside production nothing is asked of the developer", async () => {
    vi.stubEnv("APP_ENV", "development");
    expect((await checkWebsiteSigning()).state).toBe("HEALTHY");
  });

  it("the secret value never appears in the row", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
    expect(JSON.stringify(await checkWebsiteSigning())).not.toContain(SECRET);
  });
});
