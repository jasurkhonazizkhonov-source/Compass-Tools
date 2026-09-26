import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Every /api/cron/* endpoint is behind CRON_SECRET. In production an unset
// secret DISABLES the endpoints (they used to be open — one sends real email,
// one runs the card-retention purge). The secret is only ever set in the host.

const work = {
  tasks: vi.fn(async () => ({ processed: 0 })),
  cleanup: vi.fn(async () => ({ deleted: 0 })),
  retention: vi.fn(async () => ({ status: "disabled" as const })),
  sequences: vi.fn(async () => ({ sent: 0 })),
  leads: vi.fn(async () => ({ distributed: 0 })),
};
vi.mock("@/server/actions/tasks", () => ({ processDueTaskNotifications: () => work.tasks() }));
vi.mock("@/server/security/rate-limit", () => ({ cleanupExpiredRateLimitCounters: () => work.cleanup() }));
vi.mock("@/server/security/card-retention-schedule", () => ({ runScheduledCardRetention: () => work.retention() }));
vi.mock("@/server/actions/sequences", () => ({ processDueSequenceSteps: () => work.sequences() }));
vi.mock("@/server/actions/lead-queue", () => ({ distributePendingWebsiteLeads: () => work.leads() }));

const SECRET = "test-only-cron-secret-not-a-real-one";
const ROUTES = [
  ["tasks", () => import("../tasks/route"), () => [work.tasks, work.cleanup, work.retention]],
  ["sequences", () => import("../sequences/route"), () => [work.sequences]],
  ["leads", () => import("../leads/route"), () => [work.leads]],
] as const;
const call = (mod: { GET: (r: NextRequest) => Promise<Response> }, auth?: string) =>
  mod.GET(new NextRequest("http://localhost/api/cron/x", auth === undefined ? undefined : { headers: { authorization: auth } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "");
});
afterEach(() => vi.unstubAllEnvs());

describe.each(ROUTES)("/api/cron/%s", (_name, load, jobs) => {
  it("PRODUCTION without CRON_SECRET: disabled (503) and NO work runs, even for a request with a bearer header", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const mod = await load();
    for (const auth of [undefined, "Bearer anything", "Bearer "]) {
      const res = await call(mod, auth);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    for (const job of jobs()) expect(job).not.toHaveBeenCalled();
  });

  it("PRODUCTION with CRON_SECRET: only the exact bearer token runs the job", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", SECRET);
    const mod = await load();
    for (const auth of [undefined, "", SECRET, `bearer ${SECRET}`, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, "Bearer wrong"]) {
      expect((await call(mod, auth)).status, String(auth)).toBe(401);
    }
    for (const job of jobs()) expect(job).not.toHaveBeenCalled();
    const ok = await call(mod, `Bearer ${SECRET}`);
    expect(ok.status).toBe(200);
    expect(jobs()[0]).toHaveBeenCalledTimes(1);
  });

  it("APP_ENV=staging on a production build does not open it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ENV", "staging");
    expect((await call(await load())).status).toBe(503);
  });

  it("local development stays convenient: open when no secret is set, enforced when one is", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const mod = await load();
    expect((await call(mod)).status).toBe(200);
    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await call(mod)).status).toBe(401);
    expect((await call(mod, `Bearer ${SECRET}`)).status).toBe(200);
  });

  it("never echoes the secret in a response", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await call(await load(), "Bearer wrong");
    expect(await res.text()).not.toContain(SECRET);
  });
});

describe("the card-retention purge is reachable only through the authenticated cron", () => {
  it("an unauthorized /api/cron/tasks request never invokes the retention purge", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", SECRET);
    await call(await import("../tasks/route"), "Bearer wrong");
    expect(work.retention).not.toHaveBeenCalled();
  });
});
