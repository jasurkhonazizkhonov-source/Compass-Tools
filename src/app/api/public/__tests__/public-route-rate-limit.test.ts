import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 26 §35 — proves each public route handler actually rejects with a
// clean 429 when the shared rate limiter says no, and never reaches DB
// work in that case — the WIRING, not the limiter's own internal logic
// (covered in isolation by rate-limit.test.ts), mirroring
// public-rate-limit-integration.test.ts's exact pattern for
// submitBooking/confirmCancellationByCustomer.

let rateLimitAllowed: boolean;
let rateLimitCalls: Array<{ endpoint: string }>;

vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async (_headers: Headers, endpoint: string) => {
    rateLimitCalls.push({ endpoint });
    return rateLimitAllowed ? { allowed: true } : { allowed: false, retryAfterSeconds: 42 };
  }),
  RATE_LIMITS: {
    LEAD_CAPTURE: { windowMs: 1, maxAttempts: 1 },
    CONTACT_INQUIRY: { windowMs: 1, maxAttempts: 1 },
    SUBSCRIBE: { windowMs: 1, maxAttempts: 1 },
    UNSUBSCRIBE: { windowMs: 1, maxAttempts: 1 },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: { findUnique: vi.fn(async () => null) },
    subscriber: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})), upsert: vi.fn(async () => ({})) },
    sequenceEnrollment: { findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({})) },
    contactInquiry: { create: vi.fn(async () => ({ id: "inq-1" })) },
    contact: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("@/server/contact-resolution", () => ({ resolveContactForNewLead: vi.fn(async () => ({ contactId: "c1", isNewContact: false })) }));
vi.mock("@/server/actions/lead-queue", () => ({ distributeNewWebsiteLead: vi.fn(async () => {}) }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("@/server/queries/reference-data", () => ({ resolveAirportCodes: vi.fn(async () => ({})) }));
vi.mock("@/server/admin-notifications", () => ({ notifyNewInquiry: vi.fn(async () => {}), notifyNewSubscriber: vi.fn(async () => {}) }));

beforeEach(() => {
  rateLimitAllowed = true;
  rateLimitCalls = [];
  vi.clearAllMocks();
});

function req(url: string, body?: unknown) {
  return new Request(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

describe("public route handlers — rate-limit rejection (Pass 26 §35)", () => {
  it("POST /api/public/lead-capture rejects with 429 and never looks up the company", async () => {
    rateLimitAllowed = false;
    const { POST } = await import("../lead-capture/route");
    const { prisma } = await import("@/lib/prisma");
    const res = await POST(req("http://x/api/public/lead-capture", { companyId: "c1", firstName: "A", lastName: "B", phone: "+15125550100" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(prisma.company.findUnique).not.toHaveBeenCalled();
    expect(rateLimitCalls[0].endpoint).toBe("LEAD_CAPTURE");
  });

  it("POST /api/public/contact-inquiry rejects with 429 and never looks up the company", async () => {
    rateLimitAllowed = false;
    const { POST } = await import("../contact-inquiry/route");
    const { prisma } = await import("@/lib/prisma");
    const res = await POST(req("http://x/api/public/contact-inquiry", { companyId: "c1", firstName: "A", lastName: "B", email: "a@b.com", subject: "GENERAL_INQUIRY", message: "hi" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(prisma.company.findUnique).not.toHaveBeenCalled();
    expect(rateLimitCalls[0].endpoint).toBe("CONTACT_INQUIRY");
  });

  it("POST /api/public/subscribe rejects with 429 and never looks up the company", async () => {
    rateLimitAllowed = false;
    const { POST } = await import("../subscribe/route");
    const { prisma } = await import("@/lib/prisma");
    const res = await POST(req("http://x/api/public/subscribe", { companyId: "c1", email: "a@b.com" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(prisma.company.findUnique).not.toHaveBeenCalled();
    expect(rateLimitCalls[0].endpoint).toBe("SUBSCRIBE");
  });

  it("GET /api/public/unsubscribe rejects with 429 and never looks up the subscriber", async () => {
    rateLimitAllowed = false;
    const { GET } = await import("../unsubscribe/route");
    const { prisma } = await import("@/lib/prisma");
    const res = await GET(new Request("http://x/api/public/unsubscribe?token=tok"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(prisma.subscriber.findUnique).not.toHaveBeenCalled();
    expect(rateLimitCalls[0].endpoint).toBe("UNSUBSCRIBE");
  });

  it("GET /api/public/sequence-unsubscribe rejects with 429 and never looks up the enrollment", async () => {
    rateLimitAllowed = false;
    const { GET } = await import("../sequence-unsubscribe/route");
    const { prisma } = await import("@/lib/prisma");
    const res = await GET(new Request("http://x/api/public/sequence-unsubscribe?enrollment=e1"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(prisma.sequenceEnrollment.findUnique).not.toHaveBeenCalled();
    expect(rateLimitCalls[0].endpoint).toBe("SEQUENCE_UNSUBSCRIBE");
  });

  it("proceeds normally (past the rate-limit gate) when allowed — lead-capture reaches the company lookup", async () => {
    rateLimitAllowed = true;
    const { POST } = await import("../lead-capture/route");
    const { prisma } = await import("@/lib/prisma");
    await POST(req("http://x/api/public/lead-capture", { companyId: "c1", firstName: "A", lastName: "B", phone: "+15125550100" }));
    expect(prisma.company.findUnique).toHaveBeenCalled();
  });
});
