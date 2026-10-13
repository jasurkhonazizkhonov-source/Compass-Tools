import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// /api/cron/cvv-cleanup: the self-hosted deployment's scheduled CVV cleanup. Same CRON_SECRET gate as the other cron endpoints, POST
// only, does the CVV cleanup and nothing else, and reports a failed cleanup as an error (not as "0 destroyed").

const cvv = vi.fn<() => Promise<{ deleted: number; failed?: true }>>(async () => ({ deleted: 3 }));
const otherWork = vi.fn();
vi.mock("@/server/security/booking-cvv", () => ({ destroyExpiredCvvs: () => cvv() }));
// Anything else the notification/maintenance endpoint does must never be reachable from this route.
vi.mock("@/server/actions/tasks", () => ({ processDueTaskNotifications: () => otherWork("tasks") }));
vi.mock("@/server/security/card-retention-schedule", () => ({ runScheduledCardRetention: () => otherWork("retention") }));
vi.mock("@/server/security/rate-limit", () => ({ cleanupExpiredRateLimitCounters: () => otherWork("rate-limit") }));
vi.mock("@/server/attachments/cleanup", () => ({ sweepStalePendingAttachments: () => otherWork("attachments") }));

const SECRET = "test-only-cron-secret-not-a-real-one";
const url = "http://app:3000/api/cron/cvv-cleanup";
const post = async (auth?: string) => {
  const mod = await import("../cvv-cleanup/route");
  return mod.POST(new NextRequest(url, { method: "POST", headers: auth === undefined ? undefined : { authorization: auth } }));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "");
  cvv.mockResolvedValue({ deleted: 3 });
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/cron/cvv-cleanup", () => {
  it("PRODUCTION without CRON_SECRET: disabled (503) and nothing is deleted", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const auth of [undefined, "Bearer anything", "Bearer "]) {
      const res = await post(auth);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(cvv).not.toHaveBeenCalled();
  });

  it("PRODUCTION with CRON_SECRET: only the exact bearer token runs the cleanup", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const auth of [undefined, "", SECRET, `bearer ${SECRET}`, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, "Bearer wrong"]) {
      expect((await post(auth)).status, String(auth)).toBe(401);
    }
    expect(cvv).not.toHaveBeenCalled();
    const ok = await post(`Bearer ${SECRET}`);
    expect(ok.status).toBe(200);
    expect(cvv).toHaveBeenCalledTimes(1);
  });

  it("reports how many codes were destroyed, with no-store caching and no secret echoed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await post(`Bearer ${SECRET}`);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, cvvRecordsDestroyed: 3 });
    expect(typeof body.ranAt).toBe("string");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("a failed cleanup is an ERROR (500) so the scheduler retries — never a silent '0 destroyed'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", SECRET);
    cvv.mockResolvedValue({ deleted: 0, failed: true });
    const res = await post(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "CVV cleanup failed" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is safe to retry: repeated authenticated calls are independent and a second one with nothing left reports 0", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", SECRET);
    cvv.mockResolvedValueOnce({ deleted: 2 }).mockResolvedValueOnce({ deleted: 0 });
    expect((await (await post(`Bearer ${SECRET}`)).json()).cvvRecordsDestroyed).toBe(2);
    expect((await (await post(`Bearer ${SECRET}`)).json()).cvvRecordsDestroyed).toBe(0);
  });

  it("does the CVV cleanup and NOTHING else (no notifications, no card-number retention purge, no other maintenance)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", SECRET);
    await post(`Bearer ${SECRET}`);
    expect(otherWork).not.toHaveBeenCalled();
  });

  it("only POST is exposed: GET (a prefetch, a crawler, a stray link) has no handler", async () => {
    const mod = (await import("../cvv-cleanup/route")) as Record<string, unknown>;
    expect(typeof mod.POST).toBe("function");
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) expect(mod[method]).toBeUndefined();
  });

  it("APP_ENV=staging on a production build does not open it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "staging");
    expect((await post()).status).toBe(503);
  });
});
