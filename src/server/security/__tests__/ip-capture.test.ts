import { describe, it, expect, vi, beforeEach } from "vitest";

const ENCRYPTION_KEY = "YgfNgrkVYRowXtQi3KJgD2vQOgze0r12K6kTBWUQTQI=";
const HASH_KEY = "oYQZyGTNHuPCyHRql2/SVOgH3IJHTeGSchk4rLRMjzg=";

type FakeCapture = {
  id: string;
  ipHash: string;
  subnetHash: string;
  signerEmail: string | null;
  suspicious: boolean;
  capturedAt: Date;
  softDeletedAt: Date | null;
};

let existingCaptures: FakeCapture[];
let createCalls: Array<{ data: Record<string, unknown> }>;
let createShouldThrow: boolean;
let notificationCreateManyCalls: Array<{ data: Array<Record<string, unknown>> }>;
let accountsInCompany: Array<{ id: string; companyId: string; role: string; status: string }>;

function filterCaptures(where: Record<string, unknown>): FakeCapture[] {
  let rows = existingCaptures.slice();
  if (where.softDeletedAt === null) rows = rows.filter((c) => c.softDeletedAt === null);
  if (typeof where.ipHash === "string") rows = rows.filter((c) => c.ipHash === where.ipHash);
  if (typeof where.subnetHash === "string") rows = rows.filter((c) => c.subnetHash === where.subnetHash);
  if (typeof where.signerEmail === "string") rows = rows.filter((c) => c.signerEmail === where.signerEmail);
  if (where.suspicious === true) rows = rows.filter((c) => c.suspicious === true);
  const capturedAtCond = where.capturedAt as { gte?: Date } | undefined;
  if (capturedAtCond?.gte) rows = rows.filter((c) => c.capturedAt >= capturedAtCond.gte!);
  return rows;
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ipCapture: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => filterCaptures(where).length),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => filterCaptures(where)),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => filterCaptures(where)[0] ?? null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (createShouldThrow) throw new Error("db unavailable");
        createCalls.push(args);
        return { id: "capture-new", ...args.data };
      }),
    },
    account: {
      findMany: vi.fn(async ({ where }: { where: { companyId: string } }) => accountsInCompany.filter((a) => a.companyId === where.companyId)),
    },
    notification: {
      createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
        notificationCreateManyCalls.push(args);
        return { count: args.data.length };
      }),
    },
  },
}));

beforeEach(() => {
  vi.stubEnv("IP_ENCRYPTION_KEY", ENCRYPTION_KEY);
  vi.stubEnv("IP_HASH_KEY", HASH_KEY);
  existingCaptures = [];
  createCalls = [];
  createShouldThrow = false;
  notificationCreateManyCalls = [];
  accountsInCompany = [{ id: "admin-1", companyId: "company-1", role: "ADMIN", status: "ACTIVE" }];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("recordIpCapture — basic write", () => {
  it("encrypts the IP and writes a hash + subnetHash + version + formType + bookingId row for a valid IPv4 address", async () => {
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip: "203.0.113.42", userAgent: "TestAgent/1.0", formType: "NEW_BOOKING", bookingId: "booking-1", signerName: "Jane Doe", signerEmail: "jane@example.com" });

    expect(createCalls).toHaveLength(1);
    const data = createCalls[0].data;
    expect(data.encryptedIp).not.toContain("203.0.113.42");
    expect(data.ipVersion).toBe("v4");
    expect(data.formType).toBe("NEW_BOOKING");
    expect(data.bookingId).toBe("booking-1");
    expect(data.signerName).toBe("Jane Doe");
    expect(data.signerEmail).toBe("jane@example.com");
    expect(data.userAgent).toBe("TestAgent/1.0");
    expect(typeof data.subnetHash).toBe("string");
    expect(data.riskScore).toBe(0); // no prior signals seeded
  });

  it("detects IPv6 addresses correctly", async () => {
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip: "2001:0db8:85a3:0000:0000:8a2e:0370:7334", userAgent: undefined, formType: "CANCELLATION_CONFIRMATION", bookingId: "booking-2" });
    expect(createCalls[0].data.ipVersion).toBe("v6");
  });

  it("normalizes an IPv4-mapped IPv6 address to plain IPv4 before storing (matches request-ip.ts's normalizeIp)", async () => {
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip: "::ffff:203.0.113.42", userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-1" });
    expect(createCalls[0].data.ipVersion).toBe("v4");
  });

  it("is a silent no-op when ip is undefined (matches getClientIp's own 'nothing to trust' contract)", async () => {
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip: undefined, userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-1" });
    expect(createCalls).toHaveLength(0);
  });

  it("is a silent no-op for a malformed/spoofed IP value — never stores garbage", async () => {
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip: "not-an-ip; DROP TABLE", userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-1" });
    expect(createCalls).toHaveLength(0);
  });

  it("never throws when the underlying write fails — best-effort, must never block the booking/cancellation it's attached to", async () => {
    createShouldThrow = true;
    const { recordIpCapture } = await import("../ip-capture");
    await expect(recordIpCapture({ ip: "203.0.113.42", userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-1" })).resolves.toBeUndefined();
  });

  it("never logs the raw IP even when the write fails", async () => {
    createShouldThrow = true;
    const errorSpy = vi.spyOn(console, "error");
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip: "203.0.113.42", userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-1" });
    const loggedText = errorSpy.mock.calls.map((c) => c.join(" ")).join(" ");
    expect(loggedText).not.toContain("203.0.113.42");
  });
});

describe("recordIpCapture — internal fraud risk scoring (no external API)", () => {
  it("computes a nonzero risk score and stores it when the same IP has already signed twice in the window", async () => {
    const { hashIpForSearch, hashSubnetForSearch } = await import("../ip-encryption");
    const ip = "203.0.113.42";
    const ipHash = hashIpForSearch(ip);
    const subnetHash = hashSubnetForSearch(ip, "v4");
    existingCaptures.push(
      { id: "c1", ipHash, subnetHash, signerEmail: "a@example.com", suspicious: false, capturedAt: new Date(), softDeletedAt: null },
      { id: "c2", ipHash, subnetHash, signerEmail: "b@example.com", suspicious: false, capturedAt: new Date(), softDeletedAt: null }
    );
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip, userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-3", signerEmail: "c@example.com" });

    // velocityCount = 2 prior + this one = 3 -> velocity signal fires;
    // distinctEmailsForIp = {a,b,c} = 3 -> multi-email-per-IP signal fires too.
    expect((createCalls[0].data.riskScore as number)).toBeGreaterThan(0);
  });

  it("scores a previously-flagged-suspicious IP as high risk", async () => {
    const { hashIpForSearch, hashSubnetForSearch } = await import("../ip-encryption");
    const ip = "203.0.113.99";
    existingCaptures.push({ id: "c1", ipHash: hashIpForSearch(ip), subnetHash: hashSubnetForSearch(ip, "v4"), signerEmail: "flagged@example.com", suspicious: true, capturedAt: new Date(), softDeletedAt: null });
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip, userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-4" });
    expect(createCalls[0].data.riskScore).toBeGreaterThanOrEqual(40);
  });

  it("scores an entirely unremarkable IP/email combination as zero", async () => {
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip: "198.51.100.7", userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-5", signerEmail: "solo@example.com" });
    expect(createCalls[0].data.riskScore).toBe(0);
  });
});

describe("recordIpCapture — high-risk Notification alert", () => {
  it("notifies company Admins/Managers when the risk score crosses the high-risk threshold", async () => {
    const { hashIpForSearch, hashSubnetForSearch } = await import("../ip-encryption");
    const ip = "203.0.113.77";
    existingCaptures.push({ id: "c1", ipHash: hashIpForSearch(ip), subnetHash: hashSubnetForSearch(ip, "v4"), signerEmail: "flagged@example.com", suspicious: true, capturedAt: new Date(), softDeletedAt: null });
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip, userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-6", companyId: "company-1", quoteId: "quote-1" });

    expect(notificationCreateManyCalls).toHaveLength(1);
    const data = notificationCreateManyCalls[0].data;
    expect(data).toHaveLength(1); // one ADMIN account seeded
    expect(data[0].accountId).toBe("admin-1");
    expect(data[0].quoteId).toBe("quote-1");
    expect(data[0].type).toBe("IP_VAULT_HIGH_RISK");
  });

  it("does not notify anyone for a low-risk capture", async () => {
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip: "198.51.100.7", userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-7", companyId: "company-1", quoteId: "quote-1" });
    expect(notificationCreateManyCalls).toHaveLength(0);
  });

  it("skips the alert (but still stores the row) when no companyId is supplied", async () => {
    const { hashIpForSearch, hashSubnetForSearch } = await import("../ip-encryption");
    const ip = "203.0.113.88";
    existingCaptures.push({ id: "c1", ipHash: hashIpForSearch(ip), subnetHash: hashSubnetForSearch(ip, "v4"), signerEmail: "flagged2@example.com", suspicious: true, capturedAt: new Date(), softDeletedAt: null });
    const { recordIpCapture } = await import("../ip-capture");
    await recordIpCapture({ ip, userAgent: undefined, formType: "NEW_BOOKING", bookingId: "booking-8" });
    expect(createCalls).toHaveLength(1);
    expect(notificationCreateManyCalls).toHaveLength(0);
  });
});
