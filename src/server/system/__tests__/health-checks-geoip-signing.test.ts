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

  it("ready, installed and last updated: the row says when, and stays healthy", async () => {
    status.mockResolvedValue({
      state: "ready", databaseType: "DBIP-City-Lite", builtAt: new Date("2026-11-01T00:00:00Z"), ageDays: 21, installedAt: new Date("2026-11-02T04:10:00Z"),
      update: { lastAttemptAt: new Date("2026-11-02T04:10:00Z"), lastOutcome: "success", lastError: null, lastSuccessAt: new Date("2026-11-02T04:10:00Z") },
    });
    const r = await checkGeoIpDatabase();
    expect(r.state).toBe("HEALTHY");
    expect(fact(r, "Installed here")).toBe("2026-11-02");
    expect(fact(r, "Last update attempt")).toBe("Succeeded 2026-11-02");
    expect(fact(r, "Last successful update")).toBe("2026-11-02");
  });

  it("the most recent update FAILED while the database in use is still ready: a WARNING that says the database in use is unchanged, with the plain reason and the next step", async () => {
    status.mockResolvedValue({
      state: "ready", databaseType: "DBIP-City-Lite", builtAt: new Date("2026-11-01T00:00:00Z"), ageDays: 40, installedAt: new Date("2026-11-02T04:10:00Z"),
      update: { lastAttemptAt: new Date("2026-12-02T04:10:00Z"), lastOutcome: "failed", lastError: "download failed: HTTP 503", lastSuccessAt: new Date("2026-11-02T04:10:00Z") },
    });
    const r = await checkGeoIpDatabase();
    expect(r.state).toBe("WARNING");
    expect(r.classification).toBe("manual_action");
    expect(r.summary).toMatch(/last attempt to update .* failed \(download failed: HTTP 503\)/);
    expect(r.summary).toMatch(/database in use is unchanged and is 40 days old/);
    expect(r.action).toMatch(/geoip-update/);
    expect(fact(r, "Last update attempt")).toBe("Failed 2026-12-02 - download failed: HTTP 503");
    expect(fact(r, "Last successful update")).toBe("2026-11-02");
  });

  it("nothing installed and the first installation failed: a WARNING (not the quiet 'optional' note) that says locations stay country-level", async () => {
    status.mockResolvedValue({ state: "missing", update: { lastAttemptAt: new Date("2026-11-23T04:00:00Z"), lastOutcome: "failed", lastError: "no DB-IP Lite file found for 2026-11 or 2026-10", lastSuccessAt: null } });
    const r = await checkGeoIpDatabase();
    expect(r.state).toBe("WARNING");
    expect(r.summary).toMatch(/No database is installed, so locations stay country-level/);
    expect(fact(r, "Last successful update")).toBe("Never recorded");
  });

  it("the row never carries a file path even if a reason somehow does (records are cleaned when read)", async () => {
    status.mockResolvedValue({ state: "missing", update: { lastAttemptAt: new Date("2026-11-23T04:00:00Z"), lastOutcome: "failed", lastError: "open <path> failed", lastSuccessAt: null } });
    expect(JSON.stringify(await checkGeoIpDatabase())).not.toMatch(/\.mmdb|\/var\/|\/srv\/|[A-Za-z]:\\\\/);
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
  const required = (r: Awaited<ReturnType<typeof checkWebsiteSigning>>) => fact(r, "Signature required");

  it("production, secret and switch set: healthy, and says what is refused", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true");
    const r = await checkWebsiteSigning();
    expect(r.state).toBe("HEALTHY");
    expect(r.summary).toMatch(/Unsigned, replayed and modified requests are refused/);
    expect(required(r)).toBe("Yes");
  });

  it.each(["", "false"])("production with WEBSITE_SIGNATURE_REQUIRED=%j: signatures are still required, and a WARNING asks to state it before the next deployment", async (flag) => {
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", flag);
    const r = await checkWebsiteSigning();
    expect(r.state).toBe("WARNING");
    expect(r.classification).toBe("manual_action");
    expect(required(r)).toBe("Yes");
    expect(r.summary).toMatch(/next deployment will be refused/);
    expect(r.action).toContain("WEBSITE_SIGNATURE_REQUIRED=true");
  });

  it.each(["", "true"])("production with no secret (switch %j): CRITICAL, because every website request is being refused", async (flag) => {
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", flag);
    const r = await checkWebsiteSigning();
    expect(r.state).toBe("CRITICAL");
    expect(r.summary).toMatch(/being refused/);
    expect(fact(r, "Shared signing secret")).toBe("Missing");
  });

  it("outside production, the switch without a secret is also CRITICAL", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("WEBSITE_SIGNATURE_REQUIRED", "true");
    expect((await checkWebsiteSigning()).state).toBe("CRITICAL");
  });

  it("outside production without the switch nothing is asked of the developer", async () => {
    vi.stubEnv("APP_ENV", "development");
    const r = await checkWebsiteSigning();
    expect(r.state).toBe("HEALTHY");
    expect(required(r)).toBe("No");
  });

  it("the secret value never appears in the row", async () => {
    vi.stubEnv("LEAD_INGEST_SECRET", SECRET);
    expect(JSON.stringify(await checkWebsiteSigning())).not.toContain(SECRET);
  });
});
