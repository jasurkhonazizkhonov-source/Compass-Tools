import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 16 §4/§5 — regression coverage for the new automated-sequence
// unsubscribe link (previously, an unattended drip sequence had no
// unsubscribe mechanism at all). Mirrors the mocked-prisma pattern already
// established for /api/public/lead-capture's own route test.

type FakeEnrollment = { id: string; leadId: string; status: "ACTIVE" | "UNSUBSCRIBED" | "COMPLETED" };
let enrollments: Map<string, FakeEnrollment>;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    sequenceEnrollment: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => enrollments.get(where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { leadId: string; status: string }; data: { status: "UNSUBSCRIBED" } }) => {
        let count = 0;
        for (const e of enrollments.values()) {
          if (e.leadId === where.leadId && e.status === where.status) {
            e.status = data.status;
            count++;
          }
        }
        return { count };
      }),
    },
  },
}));

async function getText(res: Response) {
  return res.text();
}

describe("GET /api/public/sequence-unsubscribe", () => {
  beforeEach(() => {
    enrollments = new Map([
      ["enr-1", { id: "enr-1", leadId: "lead-1", status: "ACTIVE" }],
      // Same lead, a DIFFERENT sequence — must also be stopped (§ "stops
      // ALL of this lead's active enrollments", not just the one the
      // clicked email came from).
      ["enr-2", { id: "enr-2", leadId: "lead-1", status: "ACTIVE" }],
      // A different lead entirely — must be completely unaffected.
      ["enr-3", { id: "enr-3", leadId: "lead-2", status: "ACTIVE" }],
    ]);
  });

  it("400s with no enrollment param", async () => {
    const { GET } = await import("../route");
    const res = await GET(new Request("https://example.com/api/public/sequence-unsubscribe"));
    expect(res.status).toBe(400);
  });

  it("404s (generic, non-enumerable message) for an unknown enrollment id", async () => {
    const { GET } = await import("../route");
    const res = await GET(new Request("https://example.com/api/public/sequence-unsubscribe?enrollment=does-not-exist"));
    expect(res.status).toBe(404);
    expect(await getText(res)).not.toContain("does-not-exist");
  });

  it("unsubscribes every ACTIVE enrollment for that lead, across every sequence", async () => {
    const { GET } = await import("../route");
    const res = await GET(new Request("https://example.com/api/public/sequence-unsubscribe?enrollment=enr-1"));
    expect(res.status).toBe(200);
    expect(enrollments.get("enr-1")!.status).toBe("UNSUBSCRIBED");
    expect(enrollments.get("enr-2")!.status).toBe("UNSUBSCRIBED");
  });

  it("never touches a different lead's enrollments", async () => {
    const { GET } = await import("../route");
    await GET(new Request("https://example.com/api/public/sequence-unsubscribe?enrollment=enr-1"));
    expect(enrollments.get("enr-3")!.status).toBe("ACTIVE");
  });

  it("is idempotent — clicking an already-used link again still returns success, not an error", async () => {
    const { GET } = await import("../route");
    await GET(new Request("https://example.com/api/public/sequence-unsubscribe?enrollment=enr-1"));
    const res = await GET(new Request("https://example.com/api/public/sequence-unsubscribe?enrollment=enr-1"));
    expect(res.status).toBe(200);
  });
});
