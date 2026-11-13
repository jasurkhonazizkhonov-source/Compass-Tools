import { describe, it, expect, vi } from "vitest";

// Every unauthenticated JSON endpoint refuses an oversized body with 413 BEFORE touching the database, and still accepts a normal-sized request.

const dbTouched = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: () => { dbTouched(); throw new Error("database must not be touched for an oversized body"); } }),
}));
vi.mock("@/server/admin-notifications", () => ({ notifyNewInquiry: vi.fn(), notifyNewSubscriber: vi.fn() }));
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async () => ({ allowed: true })),
  RATE_LIMITS: { CONTACT_INQUIRY: {}, CRM_INQUIRY: {}, LEAD_CAPTURE: {}, SUBSCRIBE: {} },
}));
vi.mock("@/server/contact-resolution", () => ({ resolveContactForNewLead: vi.fn() }));
vi.mock("@/server/lead-intake", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/lead-intake")>()), createWebsiteFlightLead: vi.fn() }));

const big = JSON.stringify({ companyId: "c", firstName: "A".repeat(200 * 1024) });
const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

const routes: Array<[string, () => Promise<{ POST: (r: Request) => Promise<Response> }>]> = [
  ["/api/public/contact-inquiry", () => import("@/app/api/public/contact-inquiry/route")],
  ["/api/public/crm-inquiry", () => import("@/app/api/public/crm-inquiry/route")],
  ["/api/public/lead-capture", () => import("@/app/api/public/lead-capture/route")],
  ["/api/public/subscribe", () => import("@/app/api/public/subscribe/route")],
];

describe.each(routes)("POST %s", (url, load) => {
  it("an oversized body is refused with 413 and the database is never touched", async () => {
    const { POST } = await load();
    const res = await POST(post(url, big));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(dbTouched).not.toHaveBeenCalled();
  });

  it("a declared Content-Length far over the cap is refused the same way", async () => {
    const { POST } = await load();
    const res = await POST(post(url, "{}", { "content-length": String(40 * 1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it("an ordinary small body still reaches validation (400 invalid submission, not 413)", async () => {
    const { POST } = await load();
    const res = await POST(post(url, JSON.stringify({ companyId: "c" })));
    expect(res.status).toBe(400);
  });
});
