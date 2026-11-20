import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Recording of failed sign-in attempts: verified vs unverified identity, trusted IP (full IPv4/IPv6, forged headers ignored), duplicate delivery, flood control,
// oversized/hostile values, and that the recorder can never change the sign-in outcome. Fake database; no network.

type Event = Record<string, unknown> & { id: string };
let events: Event[];
let accounts: Array<{ email: string; companyId: string }>;
let failOn: "none" | "create" | "count" = "none";
let lookupResult: unknown;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: { findFirst: vi.fn(async ({ where }: { where: { email: { equals: string } } }) => accounts.find((a) => a.email.toLowerCase() === where.email.equals.toLowerCase()) ?? null) },
    failedSignInEvent: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const gte = (where.occurredAt as { gte: Date } | undefined)?.gte;
        return (
          events.find(
            (e) =>
              (where.attemptKey === undefined || e.attemptKey === where.attemptKey) &&
              (where.reasonCode === undefined || e.reasonCode === where.reasonCode) &&
              (where.ipAddress === undefined || e.ipAddress === where.ipAddress) &&
              (!gte || (e.occurredAt as Date) >= gte)
          ) ?? null
        );
      }),
      count: vi.fn(async ({ where }: { where: { ipAddress: string | null; occurredAt: { gte: Date }; NOT?: { reasonCode: string } } }) => {
        if (failOn === "count") throw new Error("db down");
        return events.filter((e) => e.ipAddress === where.ipAddress && (e.occurredAt as Date) >= where.occurredAt.gte && e.reasonCode !== where.NOT?.reasonCode).length;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (failOn === "create") throw new Error("db down postgres://u:p@h/db");
        const row = { id: `evt-${events.length + 1}`, repeatCount: 1, ...data };
        events.push(row as Event);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { repeatCount: { increment: number }; occurredAt: Date } }) => {
        const row = events.find((e) => e.id === where.id)!;
        row.repeatCount = (row.repeatCount as number) + data.repeatCount.increment;
        row.occurredAt = data.occurredAt;
        return row;
      }),
    },
  },
}));
vi.mock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: vi.fn(async () => lookupResult) }));

const NOW = new Date("2026-11-20T17:15:12Z");
const req = (h: Record<string, string>) => new Headers(h);

beforeEach(() => {
  events = [];
  accounts = [{ email: "sarah@example.com", companyId: "company-1" }];
  failOn = "none";
  lookupResult = { status: "unresolved", reason: "not-found" };
  vi.stubEnv("TRUSTED_PROXY", "cloudflare");
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

async function record(over: Record<string, unknown> = {}, h: Record<string, string> = { "cf-connecting-ip": "203.0.113.25" }) {
  const { recordFailedSignIn } = await import("../failed-sign-in");
  await recordFailedSignIn({ method: "GOOGLE_OAUTH", reasonCode: "UNKNOWN_ACCOUNT", headers: req(h), now: NOW, ...over } as never);
}

describe("what is recorded", () => {
  it("a verified identity: name and email are stored as VERIFIED, with the trusted IP, time, reason and method; the company comes from the matching account", async () => {
    await record({ verifiedEmail: "Sarah@Example.com", verifiedFullName: "Sarah Wilson" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: "GOOGLE_OAUTH",
      reasonCode: "UNKNOWN_ACCOUNT",
      verifiedEmail: "sarah@example.com",
      verifiedFullName: "Sarah Wilson",
      attemptedEmail: null,
      ipAddress: "203.0.113.25",
      ipVersion: "v4",
      companyId: "company-1",
      occurredAt: NOW,
    });
  });

  it("an UNVERIFIED credential (token rejected): no name and no email is stored - nothing is read out of it - only IP, time and reason", async () => {
    await record({ reasonCode: "GOOGLE_VERIFICATION_FAILED", credential: "header.eyJlbWFpbCI6ImV2aWxAZXhhbXBsZS5jb20ifQ.sig" });
    expect(events[0]).toMatchObject({ reasonCode: "GOOGLE_VERIFICATION_FAILED", verifiedEmail: null, verifiedFullName: null, attemptedEmail: null, companyId: null });
  });

  it("a name is never invented from an email address", async () => {
    await record({ verifiedEmail: "john.smith@gmail.com", verifiedFullName: null });
    expect(events[0].verifiedFullName).toBeNull();
  });

  it("an attempted (unverified) identifier is kept apart from verified fields", async () => {
    await record({ attemptedEmail: "typed@example.com" });
    expect(events[0]).toMatchObject({ attemptedEmail: "typed@example.com", verifiedEmail: null });
  });

  it("no credential, token or cookie text is stored anywhere in the row; only a short hash prefix", async () => {
    const credential = "ya29.SECRET-TOKEN-VALUE-1234567890";
    await record({ credential, reasonCode: "GOOGLE_VERIFICATION_FAILED" });
    const text = JSON.stringify(events[0]);
    expect(text).not.toContain("SECRET-TOKEN");
    expect(String(events[0].attemptKey)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("the COMPLETE IPv6 address is kept in canonical form, never truncated", async () => {
    await record({}, { "cf-connecting-ip": "2001:0DB8:85A3:0000:0000:8A2E:0370:7334" });
    expect(events[0]).toMatchObject({ ipAddress: "2001:db8:85a3::8a2e:370:7334", ipVersion: "v6" });
  });

  it("a forged X-Forwarded-For / True-Client-IP never becomes the recorded address (the trusted path wins, and with no trusted header there is no address)", async () => {
    await record({}, { "cf-connecting-ip": "203.0.113.25", "x-forwarded-for": "198.51.100.66", "true-client-ip": "198.51.100.67" });
    expect(events[0].ipAddress).toBe("203.0.113.25");
    await record({ credential: "other" }, { "x-forwarded-for": "198.51.100.66" });
    expect(events[1].ipAddress).toBeNull();
  });

  it("approximate location is stored when found, and a failed lookup never prevents the event", async () => {
    lookupResult = {
      status: "resolved",
      location: { city: "London", region: "England", country: "United Kingdom", countryCode: "GB", timeZone: "Europe/London", latitude: 51.5, longitude: -0.1, accuracyRadiusKm: null },
      source: "DBIP-City-Lite (2026-11-01)",
    };
    await record({ verifiedEmail: "sarah@example.com" });
    expect(events[0]).toMatchObject({ city: "London", country: "United Kingdom", countryCode: "GB", geoSource: "DBIP-City-Lite (2026-11-01)" });
    expect(JSON.stringify(events[0])).not.toMatch(/51\.5|latitude|longitude/); // no coordinates stored
    lookupResult = { status: "unresolved", reason: "not-found" };
    await record({ credential: "second", verifiedEmail: "sarah@example.com" });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ city: null, country: null });
  });
});

describe("hostile and oversized values", () => {
  it("control characters are removed and every field is capped", async () => {
    await record({ verifiedEmail: `${"a".repeat(400)}@example.com`, verifiedFullName: `Eve\u0000\n${"x".repeat(500)}`, attemptedEmail: "b".repeat(1000) });
    expect(String(events[0].verifiedEmail).length).toBeLessThanOrEqual(254);
    expect(String(events[0].verifiedFullName).length).toBeLessThanOrEqual(200);
    expect(String(events[0].verifiedFullName)).not.toMatch(/[\u0000-\u001f]/);
    expect(String(events[0].attemptedEmail).length).toBeLessThanOrEqual(254);
  });
});

describe("every attempt is its own row - except a duplicate delivery of the same attempt", () => {
  it("five different attempts make five rows (none overwritten or merged)", async () => {
    for (let i = 0; i < 5; i++) await record({ credential: `cred-${i}`, now: new Date(NOW.getTime() + i * 60_000), verifiedEmail: "sarah@example.com" });
    expect(events).toHaveLength(5);
  });

  it("the same credential delivered again within a minute (a retried callback) is the same attempt: still one row", async () => {
    await record({ credential: "same", reasonCode: "GOOGLE_VERIFICATION_FAILED" });
    await record({ credential: "same", reasonCode: "GOOGLE_VERIFICATION_FAILED", now: new Date(NOW.getTime() + 5000) });
    expect(events).toHaveLength(1);
  });

  it("the same credential an hour later is a new attempt", async () => {
    await record({ credential: "same" });
    await record({ credential: "same", now: new Date(NOW.getTime() + 3_600_000) });
    expect(events).toHaveLength(2);
  });
});

describe("flood control - bounded volume, nothing silently invisible", () => {
  it("beyond 20 attempts per address per 10 minutes the extra attempts are folded into ONE roll-up row with a count", async () => {
    for (let i = 0; i < 20; i++) await record({ credential: `c${i}`, now: new Date(NOW.getTime() + i * 1000) });
    expect(events).toHaveLength(20);
    for (let i = 20; i < 45; i++) await record({ credential: `c${i}`, now: new Date(NOW.getTime() + i * 1000) });
    expect(events).toHaveLength(21);
    const rollup = events[20];
    expect(rollup).toMatchObject({ reasonCode: "EVENTS_SUPPRESSED", repeatCount: 25, ipAddress: "203.0.113.25" });
  });

  it("another address is not affected by one address's flood", async () => {
    for (let i = 0; i < 30; i++) await record({ credential: `c${i}`, now: new Date(NOW.getTime() + i * 1000) });
    await record({ credential: "other" }, { "cf-connecting-ip": "203.0.113.99" });
    expect(events.filter((e) => e.ipAddress === "203.0.113.99")).toHaveLength(1);
  });

  it("after the window the address records individually again", async () => {
    for (let i = 0; i < 30; i++) await record({ credential: `c${i}`, now: new Date(NOW.getTime() + i * 1000) });
    await record({ credential: "later", now: new Date(NOW.getTime() + 20 * 60_000) });
    expect(events.at(-1)).toMatchObject({ reasonCode: "UNKNOWN_ACCOUNT" });
  });
});

describe("never changes the sign-in outcome", () => {
  it("a database failure while recording is swallowed (category logged, no connection string)", async () => {
    failOn = "create";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(record({ verifiedEmail: "sarah@example.com" })).resolves.toBeUndefined();
    const logged = err.mock.calls.flat().join(" ");
    expect(logged).toMatch(/could not record/);
    expect(logged).not.toMatch(/postgres:\/\/|sarah@example\.com/);
    err.mockRestore();
  });

  it("a failure while counting recent events is also swallowed", async () => {
    failOn = "count";
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(record()).resolves.toBeUndefined();
  });
});
