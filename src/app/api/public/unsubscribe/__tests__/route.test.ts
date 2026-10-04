import { describe, it, expect, vi, beforeEach } from "vitest";

// The public marketing-unsubscribe flow. GET shows the confirmation page and never changes anything;
// POST performs the unsubscribe, with an optional reason that is validated and stored only if given.
// Idempotent, never resubscribes, never exposes the token or an id.

type FakeSubscriber = {
  id: string;
  email: string;
  status: "SUBSCRIBED" | "UNSUBSCRIBED";
  unsubscribeToken: string;
  unsubscribedAt: Date | null;
  unsubscribeReasonCategory: string | null;
  unsubscribeReason: string | null;
  unsubscribeSource: string | null;
  company: { name: string };
};
let subs: Map<string, FakeSubscriber>; // keyed by token
let updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
let rateLimit: { allowed: true } | { allowed: false; retryAfterSeconds: number };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscriber: {
      findUnique: vi.fn(async ({ where }: { where: { unsubscribeToken: string } }) => subs.get(where.unsubscribeToken) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
        updateManyCalls.push({ where, data });
        let count = 0;
        for (const s of subs.values()) {
          if (s.id === where.id && s.status === where.status) {
            Object.assign(s, data);
            count++;
          }
        }
        return { count };
      }),
    },
  },
}));
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async () => rateLimit),
  RATE_LIMITS: { UNSUBSCRIBE: { windowMs: 1, maxAttempts: 1 } },
}));

const BASE = "https://app.example.com/api/public/unsubscribe";
const get = (qs = "") => new Request(`${BASE}${qs}`);
const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "app.example.com", ...headers }, body: new URLSearchParams(fields).toString() });

beforeEach(() => {
  rateLimit = { allowed: true };
  updateManyCalls = [];
  subs = new Map([
    ["tok-active", { id: "sub-1", email: "jane.doe@example.com", status: "SUBSCRIBED", unsubscribeToken: "tok-active", unsubscribedAt: null, unsubscribeReasonCategory: null, unsubscribeReason: null, unsubscribeSource: null, company: { name: "Meridian Air Charter" } }],
    ["tok-gone", { id: "sub-2", email: "old@example.com", status: "UNSUBSCRIBED", unsubscribeToken: "tok-gone", unsubscribedAt: new Date("2026-01-01"), unsubscribeReasonCategory: "TOO_MANY_EMAILS", unsubscribeReason: "first reason", unsubscribeSource: "EMAIL_LINK", company: { name: "Meridian Air Charter" } }],
    ["tok-other", { id: "sub-3", email: "other@example.com", status: "SUBSCRIBED", unsubscribeToken: "tok-other", unsubscribedAt: null, unsubscribeReasonCategory: null, unsubscribeReason: null, unsubscribeSource: null, company: { name: "Other Co" } }],
  ]);
});

describe("GET — the confirmation page", () => {
  it("renders the premium confirmation page and changes NOTHING (a mail scanner pre-fetching the link cannot unsubscribe anyone)", async () => {
    const { GET } = await import("../route");
    const res = await GET(get("?token=tok-active"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Unsubscribe from marketing emails");
    expect(html).toContain("j***@example.com");
    expect(html).not.toContain("jane.doe@example.com");
    expect(html).not.toMatch(/Meridian|Other Co|Business Flights/i); // the page names no sender or agency
    expect(html).toContain("Why are you unsubscribing?");
    expect(subs.get("tok-active")!.status).toBe("SUBSCRIBED");
    expect(updateManyCalls).toHaveLength(0);
  });

  it("an already-unsubscribed link says so and offers no form; nothing is rewritten", async () => {
    const { GET } = await import("../route");
    const res = await GET(get("?token=tok-gone"));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("already unsubscribed");
    expect(html).not.toContain("<form");
    expect(updateManyCalls).toHaveLength(0);
  });

  it("a missing token → 400, an unknown token → 404 (same premium page, no internals, no echo of the token)", async () => {
    const { GET } = await import("../route");
    const missing = await GET(get());
    expect(missing.status).toBe(400);
    const bad = await GET(get("?token=does-not-exist-123"));
    expect(bad.status).toBe(404);
    const html = await bad.text();
    expect(html).toContain("no longer valid");
    expect(html).toContain("Compass Tools");
    expect(html).not.toContain("does-not-exist-123");
    expect(html).not.toMatch(/prisma|database|subscriber/i);
  });

  it("rate limited → 429 with Retry-After, no lookup", async () => {
    rateLimit = { allowed: false, retryAfterSeconds: 120 };
    const { GET } = await import("../route");
    const res = await GET(get("?token=tok-active"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
  });
});

describe("POST — unsubscribe, with an optional reason", () => {
  it("unsubscribes with NO reason: status flips, the source is recorded, no reason columns are written", async () => {
    const { POST } = await import("../route");
    const res = await POST(post({ token: "tok-active" }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("You're unsubscribed");
    expect(html).not.toContain("Thank you for your feedback");
    const s = subs.get("tok-active")!;
    expect(s.status).toBe("UNSUBSCRIBED");
    expect(s.unsubscribedAt).toBeInstanceOf(Date);
    expect(s.unsubscribeSource).toBe("EMAIL_LINK");
    expect(s.unsubscribeReasonCategory).toBeNull();
    expect(s.unsubscribeReason).toBeNull();
  });

  it("stores a provided category and comment against THAT subscriber only", async () => {
    const { POST } = await import("../route");
    const res = await POST(post({ token: "tok-active", reason: "NOT_RELEVANT", comment: "  Content isn't relevant to my business.  " }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Thank you for your feedback");
    expect(subs.get("tok-active")).toMatchObject({ status: "UNSUBSCRIBED", unsubscribeReasonCategory: "NOT_RELEVANT", unsubscribeReason: "Content isn't relevant to my business." });
    expect(subs.get("tok-other")).toMatchObject({ status: "SUBSCRIBED", unsubscribeReason: null });
  });

  it("a malicious comment is stored as inert plain text, and never reflected as markup", async () => {
    const { POST } = await import("../route");
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const res = await POST(post({ token: "tok-active", comment: evil }));
    const html = await res.text();
    expect(subs.get("tok-active")!.unsubscribeReason).toBe(evil); // literal characters, escaped wherever shown
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
  });

  it("a comment over the limit is refused with the form re-rendered (400), nothing is stored and the customer stays subscribed", async () => {
    const { POST } = await import("../route");
    const res = await POST(post({ token: "tok-active", reason: "OTHER", comment: "x".repeat(1001) }));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("under 1000 characters");
    expect(html).toContain("<form");
    expect(subs.get("tok-active")!.status).toBe("SUBSCRIBED");
    expect(updateManyCalls).toHaveLength(0);
  });

  it("a tampered reason category is dropped, not stored, and does not block the unsubscribe", async () => {
    const { POST } = await import("../route");
    const res = await POST(post({ token: "tok-active", reason: "'; DROP TABLE Subscriber; --" }));
    expect(res.status).toBe(200);
    expect(subs.get("tok-active")).toMatchObject({ status: "UNSUBSCRIBED", unsubscribeReasonCategory: null });
  });

  it("is idempotent: a second submit finds it already unsubscribed and NEVER overwrites the first reason", async () => {
    const { POST } = await import("../route");
    await POST(post({ token: "tok-active", reason: "TOO_MANY_EMAILS", comment: "first" }));
    const second = await POST(post({ token: "tok-active", reason: "OTHER", comment: "second attempt" }));
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("already unsubscribed");
    expect(subs.get("tok-active")).toMatchObject({ unsubscribeReasonCategory: "TOO_MANY_EMAILS", unsubscribeReason: "first" });
  });

  it("an already-unsubscribed subscriber posting again is untouched (reason and date preserved) and is NEVER re-subscribed", async () => {
    const { POST } = await import("../route");
    const before = { ...subs.get("tok-gone")! };
    const res = await POST(post({ token: "tok-gone", comment: "overwrite me" }));
    expect(res.status).toBe(200);
    expect(subs.get("tok-gone")).toEqual(before);
    expect(subs.get("tok-gone")!.status).toBe("UNSUBSCRIBED");
    expect(updateManyCalls).toHaveLength(0);
  });

  it("two simultaneous submits: exactly one changes the record (conditional on still being SUBSCRIBED)", async () => {
    const { POST } = await import("../route");
    const [a, b] = await Promise.all([POST(post({ token: "tok-active", comment: "A" })), POST(post({ token: "tok-active", comment: "B" }))]);
    const texts = await Promise.all([a.text(), b.text()]);
    expect(texts.filter((t) => t.includes("You're unsubscribed"))).toHaveLength(1);
    expect(updateManyCalls.every((c) => c.where.status === "SUBSCRIBED")).toBe(true);
  });

  it("invalid token → 404; missing token field → 400; nothing changes", async () => {
    const { POST } = await import("../route");
    expect((await POST(post({ token: "nope" }))).status).toBe(404);
    expect((await POST(post({ comment: "x" }))).status).toBe(400);
    expect(updateManyCalls).toHaveLength(0);
  });

  it("a real browser form post — Origin: null (because the page sends no Referer) with Sec-Fetch-Site: same-origin — works", async () => {
    const { POST } = await import("../route");
    const res = await POST(post({ token: "tok-active" }, { origin: "null", "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(200);
    expect(subs.get("tok-active")!.status).toBe("UNSUBSCRIBED");
  });

  it("Fetch-Metadata says cross-site / same-site → refused and nothing changes, whatever Origin claims", async () => {
    const { POST } = await import("../route");
    for (const site of ["cross-site", "same-site"]) {
      const res = await POST(post({ token: "tok-active" }, { origin: "https://app.example.com", "sec-fetch-site": site }));
      expect(res.status, site).toBe(500);
    }
    expect(subs.get("tok-active")!.status).toBe("SUBSCRIBED");
  });

  it("a cross-site POST (foreign Origin) is refused and changes nothing; a same-origin one works", async () => {
    const { POST } = await import("../route");
    const cross = await POST(post({ token: "tok-active" }, { origin: "https://evil.example.net" }));
    expect(cross.status).toBe(500); // generic error page — no detail
    expect(subs.get("tok-active")!.status).toBe("SUBSCRIBED");
    const same = await POST(post({ token: "tok-active" }, { origin: "https://app.example.com" }));
    expect(same.status).toBe(200);
    expect(subs.get("tok-active")!.status).toBe("UNSUBSCRIBED");
  });

  it("rate limited → 429 and nothing changes", async () => {
    rateLimit = { allowed: false, retryAfterSeconds: 60 };
    const { POST } = await import("../route");
    expect((await POST(post({ token: "tok-active" }))).status).toBe(429);
    expect(subs.get("tok-active")!.status).toBe("SUBSCRIBED");
  });

  it("responses never contain the token, an internal id or the full address", async () => {
    const { POST } = await import("../route");
    const html = await (await POST(post({ token: "tok-active", comment: "bye" }))).text();
    expect(html).not.toContain("tok-active");
    expect(html).not.toContain("sub-1");
    expect(html).not.toContain("jane.doe@example.com");
  });

  it("the route has no code path that sets a subscriber back to SUBSCRIBED", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src", "app", "api", "public", "unsubscribe", "route.ts"), "utf-8");
    expect(src.match(/data:\s*\{/g)).toHaveLength(1); // the only write is the unsubscribe itself
    expect(src).toContain('status: "UNSUBSCRIBED"');
    expect(src).not.toMatch(/data:\s*\{[^}]*"SUBSCRIBED"/);
  });
});
