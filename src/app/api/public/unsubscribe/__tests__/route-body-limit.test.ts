import { describe, it, expect, vi, beforeEach } from "vitest";

// The public unsubscribe POST reads its form through a byte cap (src/server/security/read-limited-form.ts) instead of req.formData(), which
// buffers whatever it is sent. The normal behaviour is covered by route.test.ts; this file pins the cap and proves the existing flow is unchanged
// for a real submission, for both content types a browser can send. Prisma and the rate limiter are mocks: no database is involved.

let findCalls = 0;
let updateCalls = 0;
vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscriber: {
      findUnique: vi.fn(async () => {
        findCalls++;
        return { id: "sub-1", email: "jane.doe@example.com", status: "SUBSCRIBED", unsubscribeToken: "tok-active", company: { name: "Acme" } };
      }),
      updateMany: vi.fn(async () => {
        updateCalls++;
        return { count: 1 };
      }),
    },
  },
}));
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async () => ({ allowed: true })),
  RATE_LIMITS: { UNSUBSCRIBE: { windowMs: 1, maxAttempts: 1 } },
}));

const BASE = "https://app.example.com/api/public/unsubscribe";
const headers = (extra: Record<string, string> = {}) => ({ host: "app.example.com", "content-type": "application/x-www-form-urlencoded", ...extra });

beforeEach(() => {
  findCalls = 0;
  updateCalls = 0;
});

describe("POST /api/public/unsubscribe - request body cap", () => {
  it("a normal urlencoded submission still unsubscribes exactly as before", async () => {
    const { POST } = await import("../route");
    const res = await POST(new Request(BASE, { method: "POST", headers: headers(), body: new URLSearchParams({ token: "tok-active", reason: "OTHER", comment: "no longer travelling" }).toString() }));
    expect(res.status).toBe(200);
    expect(updateCalls).toBe(1);
  });

  it("a normal multipart submission still works", async () => {
    const { POST } = await import("../route");
    const fd = new FormData();
    fd.set("token", "tok-active");
    const encoded = new Response(fd);
    const res = await POST(new Request(BASE, { method: "POST", headers: headers({ "content-type": encoded.headers.get("content-type") ?? "" }), body: await encoded.arrayBuffer() }));
    expect(res.status).toBe(200);
    expect(updateCalls).toBe(1);
  });

  it("a body over the cap is refused before any lookup or write (declared length)", async () => {
    const { POST } = await import("../route");
    const big = new URLSearchParams({ token: "tok-active", comment: "x".repeat(40 * 1024) }).toString();
    const res = await POST(new Request(BASE, { method: "POST", headers: headers({ "content-length": String(big.length) }), body: big }));
    expect(res.status).toBe(400); // the sender's problem, not a server fault
    expect(findCalls).toBe(0);
    expect(updateCalls).toBe(0);
    const html = await res.text();
    expect(html).not.toMatch(/jane\.doe|tok-active|Acme/);
  });

  it("a body over the cap is refused even when Content-Length is missing or lies, and the stream is cancelled", async () => {
    const { POST } = await import("../route");
    let cancelled = false;
    const chunk = new TextEncoder().encode("token=tok-active&comment=" + "x".repeat(8 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk); // endless: the server must stop reading at the cap
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = await POST(new Request(BASE, { method: "POST", headers: headers({ "content-length": "100" }), body: stream, duplex: "half" } as RequestInit));
    expect(findCalls).toBe(0);
    expect(updateCalls).toBe(0);
    expect(cancelled).toBe(true);
    expect(res.status).toBe(400);
  });

  it("a body that is not a parseable form is treated as a missing token, never a server error", async () => {
    const { POST } = await import("../route");
    const res = await POST(new Request(BASE, { method: "POST", headers: headers({ "content-type": "multipart/form-data; boundary=nope" }), body: "garbage" }));
    expect(res.status).not.toBe(500);
    expect(updateCalls).toBe(0);
  });
});
