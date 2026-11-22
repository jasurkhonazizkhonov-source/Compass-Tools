import { describe, it, expect, vi, beforeEach } from "vitest";

// RFC 8058 one-click unsubscribe: the mailbox provider POSTs `List-Unsubscribe=One-Click` to the List-Unsubscribe URL (the token is in the URL). Prisma and the
// rate limiter are mocks: no database is involved.

type Row = { id: string; email: string; status: string; unsubscribeToken: string };
let rows: Row[];
const updates: Array<Record<string, unknown>> = [];
vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscriber: {
      findUnique: vi.fn(async ({ where }: { where: { unsubscribeToken: string } }) => rows.find((r) => r.unsubscribeToken === where.unsubscribeToken) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => r.id === where.id && r.status === where.status);
        hit.forEach((r) => Object.assign(r, data));
        updates.push(data);
        return { count: hit.length };
      }),
    },
  },
}));
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async () => ({ allowed: true })),
  RATE_LIMITS: { UNSUBSCRIBE: { windowMs: 1, maxAttempts: 1 } },
}));

const URL_FOR = (token: string) => `https://app.example.com/api/public/unsubscribe?token=${token}`;
// What a mailbox provider sends: no Origin, no Referer, no cookies; just the form marker.
const oneClick = (token: string, body = "List-Unsubscribe=One-Click") =>
  new Request(URL_FOR(token), { method: "POST", headers: { host: "app.example.com", "content-type": "application/x-www-form-urlencoded" }, body });

beforeEach(() => {
  rows = [
    { id: "s1", email: "jane.doe@example.com", status: "SUBSCRIBED", unsubscribeToken: "tok-active" },
    { id: "s2", email: "gone@example.com", status: "UNSUBSCRIBED", unsubscribeToken: "tok-gone" },
  ];
  updates.length = 0;
});

describe("POST /api/public/unsubscribe - RFC 8058 one-click", () => {
  it("unsubscribes the person in one request with no page, no Origin and no reason, and records where it came from", async () => {
    const { POST } = await import("../route");
    const res = await POST(oneClick("tok-active"));
    expect(res.status).toBe(200);
    expect(rows[0].status).toBe("UNSUBSCRIBED");
    expect(updates[0]).toMatchObject({ status: "UNSUBSCRIBED", unsubscribeSource: "EMAIL_ONE_CLICK" });
    expect(updates[0]).not.toHaveProperty("unsubscribeReason");
    expect(await res.text()).not.toMatch(/jane|example\.com/); // nothing about the person in the answer
  });

  it("is idempotent: pressing it again (or an already-unsubscribed person) is still a 200 and changes nothing", async () => {
    const { POST } = await import("../route");
    expect((await POST(oneClick("tok-gone"))).status).toBe(200);
    expect((await POST(oneClick("tok-active"))).status).toBe(200);
    expect((await POST(oneClick("tok-active"))).status).toBe(200);
    expect(updates).toHaveLength(1);
  });

  it("an unknown token is a 404 and nothing is written", async () => {
    const { POST } = await import("../route");
    expect((await POST(oneClick("nope"))).status).toBe(404);
    expect(updates).toHaveLength(0);
  });

  it("without the exact marker, a request with the token only in the URL is NOT a one-click request: the ordinary form rules apply and nothing is written", async () => {
    const { POST } = await import("../route");
    const res = await POST(oneClick("tok-active", "something=else"));
    expect(rows[0].status).toBe("SUBSCRIBED");
    expect(updates).toHaveLength(0);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("a marker with the token only in the BODY is not a one-click request either: it is handled by the ordinary confirmed-form path (never recorded as EMAIL_ONE_CLICK)", async () => {
    const { POST } = await import("../route");
    await POST(new Request("https://app.example.com/api/public/unsubscribe", { method: "POST", headers: { host: "app.example.com", "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click&token=tok-active&reason=OTHER&comment=thanks" }));
    for (const u of updates) expect(u.unsubscribeSource).not.toBe("EMAIL_ONE_CLICK");
  });
});
