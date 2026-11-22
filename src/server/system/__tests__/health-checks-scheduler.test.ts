import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The System Health row for automatic sequence sending: one test per displayed state, driven by the SAME scheduler state /api/health reports (not a guess).

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { markPollerStarted, markSweepFinished, resetSchedulerStatusForTests, SCHEDULER_STALL_AFTER_MS } from "@/server/scheduler-status";
import { checkSequenceScheduler } from "../health-checks";

const NOW = Date.UTC(2026, 10, 20, 12);
const fact = (r: Awaited<ReturnType<typeof checkSequenceScheduler>>, label: string) => r.facts?.find((f) => f.label === label)?.value;

beforeEach(() => {
  resetSchedulerStatusForTests();
  vi.stubEnv("DISABLE_IN_PROCESS_POLLER", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("System Health - Automatic sequence sending", () => {
  it("RUNNING: healthy only after a run really finished; says it is operational and when", async () => {
    markPollerStarted(NOW - 5 * 60_000);
    markSweepFinished("sequences", { ok: true, processed: 4, sent: 3, failed: 1 }, NOW - 30_000);
    const r = await checkSequenceScheduler(NOW);
    expect(r.state).toBe("HEALTHY");
    expect(r.summary).toMatch(/running/i);
    expect(fact(r, "Background sender enabled")).toBe("Yes");
    expect(fact(r, "Automatic sending operational")).toBe("Yes");
    expect(fact(r, "Last successful run")).toBe("2026-11-20 11:59:30 UTC");
    expect(fact(r, "Last run (looked at / sent / failed)")).toBe("4 / 3 / 1");
    expect(r.facts?.some((f) => f.label.startsWith("Last error"))).toBe(false);
    expect(r.action).toBeUndefined();
  });

  it("DISABLED: an intentional configuration, shown as a warning that needs a manual action, never as healthy", async () => {
    vi.stubEnv("DISABLE_IN_PROCESS_POLLER", "true");
    const r = await checkSequenceScheduler(NOW);
    expect(r.state).toBe("WARNING");
    expect(r.classification).toBe("manual_action");
    expect(r.summary).toMatch(/switched off/i);
    expect(r.action).toMatch(/\/api\/cron\/sequences/);
    expect(fact(r, "Background sender enabled")).toMatch(/^No/);
    expect(fact(r, "Automatic sending operational")).toBe("No");
  });

  it("STALLED (last run failed): critical, names the error CATEGORY only, and says it recovers by itself", async () => {
    markPollerStarted(NOW - 10 * 60_000);
    markSweepFinished("sequences", { ok: true }, NOW - 5 * 60_000);
    markSweepFinished("sequences", { ok: false, errorTag: "PrismaClientKnownRequestError" }, NOW - 30_000);
    const r = await checkSequenceScheduler(NOW);
    expect(r.state).toBe("CRITICAL");
    expect(r.summary).toMatch(/stalled.*last run failed/i);
    expect(fact(r, "Last error (category)")).toBe("PrismaClientKnownRequestError");
    expect(fact(r, "Consecutive failed runs")).toBe("1");
    expect(fact(r, "Automatic sending operational")).toBe("No");
    expect(r.action).toMatch(/recovers by itself/i);
  });

  it("STALLED (silent): enabled and started, but no run finished for longer than the stall window", async () => {
    markPollerStarted(NOW - 20 * 60_000);
    markSweepFinished("sequences", { ok: true }, NOW - SCHEDULER_STALL_AFTER_MS - 60_000);
    const r = await checkSequenceScheduler(NOW);
    expect(r.state).toBe("CRITICAL");
    expect(r.summary).toMatch(/no run has finished/i);
    expect(fact(r, "Automatic sending operational")).toBe("No");
  });

  it("UNKNOWN: the sender has not started in this process, so no claim is made either way", async () => {
    const r = await checkSequenceScheduler(NOW);
    expect(r.state).toBe("UNKNOWN");
    expect(r.summary).toMatch(/cannot be established|has not started/i);
    expect(fact(r, "Automatic sending operational")).toBe("No");
  });

  it("a live process is NOT evidence: a started poller that has never finished a run for over three minutes is stalled, not running", async () => {
    markPollerStarted(NOW - SCHEDULER_STALL_AFTER_MS - 1000);
    expect((await checkSequenceScheduler(NOW)).state).toBe("CRITICAL");
  });

  it("the row never carries a message, stack, recipient or path: only a short category", async () => {
    markPollerStarted(NOW - 60_000);
    markSweepFinished("sequences", { ok: false, errorTag: "x".repeat(200) }, NOW - 1000);
    const r = await checkSequenceScheduler(NOW);
    expect(String(fact(r, "Last error (category)")).length).toBeLessThanOrEqual(60);
    expect(JSON.stringify(r)).not.toMatch(/postgres(ql)?:\/\/|\bat\s+\S+\s+\(|@[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});

import { checkMarketingWorkers } from "../health-checks";
import { markSweepStarted } from "@/server/scheduler-status";

describe("System Health - Subscriber imports and campaign delivery", () => {
  const ok = (job: "subscriber-imports" | "campaigns", at: number) => {
    markSweepStarted(job, at - 1000);
    markSweepFinished(job, { ok: true, processed: 3, sent: 2, failed: 0 }, at);
  };

  it("HEALTHY only when BOTH jobs completed a run recently", async () => {
    markPollerStarted(NOW - 5 * 60_000);
    ok("subscriber-imports", NOW - 20_000);
    ok("campaigns", NOW - 30_000);
    const r = await checkMarketingWorkers(NOW);
    expect(r.state).toBe("HEALTHY");
    expect(fact(r as never, "Imports: last successful run")).toBe("2026-11-20 11:59:40 UTC");
    expect(fact(r as never, "Campaign delivery: last successful run")).toBe("2026-11-20 11:59:30 UTC");
  });

  it("CRITICAL when either job failed on its last run - error CATEGORY only, with the consecutive count", async () => {
    markPollerStarted(NOW - 5 * 60_000);
    ok("subscriber-imports", NOW - 20_000);
    markSweepFinished("campaigns", { ok: false, errorTag: "PrismaClientKnownRequestError" }, NOW - 10_000);
    const r = await checkMarketingWorkers(NOW);
    expect(r.state).toBe("CRITICAL");
    expect(fact(r as never, "Campaign delivery: last error (category)")).toBe("PrismaClientKnownRequestError");
    expect(JSON.stringify(r)).not.toMatch(/@|postgres:|password/i);
  });

  it("CRITICAL when a job has been silent longer than the stall window; it recovers on the next successful run", async () => {
    markPollerStarted(NOW - 30 * 60_000);
    ok("subscriber-imports", NOW - SCHEDULER_STALL_AFTER_MS - 60_000);
    ok("campaigns", NOW - 10_000);
    expect((await checkMarketingWorkers(NOW)).state).toBe("CRITICAL");
    ok("subscriber-imports", NOW - 5_000);
    expect((await checkMarketingWorkers(NOW)).state).toBe("HEALTHY");
  });

  it("WARNING (manual action) when the poller is switched off, UNKNOWN before it started, and neither is shown as healthy", async () => {
    vi.stubEnv("DISABLE_IN_PROCESS_POLLER", "true");
    const off = await checkMarketingWorkers(NOW);
    expect(off.state).toBe("WARNING");
    expect(off.classification).toBe("manual_action");
    vi.stubEnv("DISABLE_IN_PROCESS_POLLER", "");
    expect((await checkMarketingWorkers(NOW)).state).toBe("UNKNOWN");
  });
});
