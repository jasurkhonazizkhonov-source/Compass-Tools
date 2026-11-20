import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getSchedulerStatus, resetSchedulerStatusForTests, sequenceSchedulerState } from "@/server/scheduler-status";

// The in-process poller started by src/instrumentation.ts register(): ON by default (the VPS deployment relies on it for task-due notifications AND for the
// automatic sending of sequence steps), switched off by DISABLE_IN_PROCESS_POLLER, started once per process, never on the edge runtime. One once-a-minute tick
// drives both jobs; a job still running is skipped, and one job failing never stops the other. Timers are fake; the sweeps are mocks; nothing touches a database.

const runDueTaskNotifications = vi.fn();
vi.mock("@/server/due-task-notifications", () => ({ runDueTaskNotifications: () => runDueTaskNotifications() }));
const drainDueSequenceSteps = vi.fn();
vi.mock("@/server/due-sequence-steps", () => ({ drainDueSequenceSteps: () => drainDueSequenceSteps() }));

beforeEach(() => {
  vi.useFakeTimers();
  runDueTaskNotifications.mockReset().mockResolvedValue({});
  drainDueSequenceSteps.mockReset().mockResolvedValue({ processed: 0, sent: 0, failed: 0, batches: 1 });
  resetSchedulerStatusForTests();
  globalThis.__taskNotifierStarted = undefined;
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("DISABLE_IN_PROCESS_POLLER", "");
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  globalThis.__taskNotifierStarted = undefined;
});

async function boot() {
  const { register } = await import("../instrumentation");
  await register();
}

describe("in-process poller (register)", () => {
  it("default: starts a 60 s interval whose every tick runs BOTH the task-notification sweep and the sequence-step sweep", async () => {
    await boot();
    expect(runDueTaskNotifications).not.toHaveBeenCalled();
    expect(drainDueSequenceSteps).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(drainDueSequenceSteps).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(1);
    expect(drainDueSequenceSteps).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(3);
    expect(drainDueSequenceSteps).toHaveBeenCalledTimes(3);
  });

  it.each(["true", "1", "yes", "on", "TRUE", " On "])("DISABLE_IN_PROCESS_POLLER=%j: nothing is started", async (value) => {
    vi.stubEnv("DISABLE_IN_PROCESS_POLLER", value);
    await boot();
    expect(globalThis.__taskNotifierStarted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runDueTaskNotifications).not.toHaveBeenCalled();
    expect(drainDueSequenceSteps).not.toHaveBeenCalled();
  });

  it.each(["", "false", "0", "no", "off", "disabled"])("DISABLE_IN_PROCESS_POLLER=%j: the poller stays ON (an unknown value never silently disables it)", async (value) => {
    vi.stubEnv("DISABLE_IN_PROCESS_POLLER", value);
    await boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(1);
    expect(drainDueSequenceSteps).toHaveBeenCalledTimes(1);
  });

  it("registering twice (dev fast-refresh) starts ONE interval, not two", async () => {
    await boot();
    await boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(1);
    expect(drainDueSequenceSteps).toHaveBeenCalledTimes(1);
  });

  it("the edge runtime starts nothing", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await boot();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runDueTaskNotifications).not.toHaveBeenCalled();
    expect(drainDueSequenceSteps).not.toHaveBeenCalled();
  });

  it("a failing sweep is logged and the interval keeps running (it never becomes an unhandled rejection)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    runDueTaskNotifications.mockRejectedValueOnce(new Error("db down")).mockResolvedValue({});
    await boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[task-notifier\] failed \(.+\)$/)); // the category only: no error object, no message text
    expect(JSON.stringify(log.mock.calls)).not.toContain("db down");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  it("a failing SEQUENCE sweep is logged, marked failed for health, and neither stops the task sweep nor the interval", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    drainDueSequenceSteps.mockRejectedValueOnce(new Error("provider down")).mockResolvedValue({ processed: 2, sent: 2, failed: 0, batches: 1 });
    await boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[sequence-sender\] failed \(.+\)$/));
    expect(JSON.stringify(log.mock.calls)).not.toContain("provider down");
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(1);
    expect(getSchedulerStatus().jobs.sequences.lastOk).toBe(false);
    expect(sequenceSchedulerState(false)).toBe("stalled");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drainDueSequenceSteps).toHaveBeenCalledTimes(2);
    expect(getSchedulerStatus().jobs.sequences).toMatchObject({ lastOk: true, lastSent: 2, consecutiveFailures: 0 });
    expect(sequenceSchedulerState(false)).toBe("running");
    log.mockRestore();
  });

  it("a sweep that is still running when the next tick fires is not started a second time (no overlapping runs in one process)", async () => {
    let release: (v: unknown) => void = () => {};
    drainDueSequenceSteps.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await boot();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drainDueSequenceSteps).toHaveBeenCalledTimes(1); // the first run never finished, so ticks 2 and 3 skipped it
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(3); // ...while the independent task job kept its own schedule
    release({ processed: 0, sent: 0, failed: 0, batches: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drainDueSequenceSteps).toHaveBeenCalledTimes(2);
  });

  it("a run that never finishes does not block its job forever: after ten minutes a new run starts, and the old one settling later does not disturb it", async () => {
    let releaseOld: (v: unknown) => void = () => {};
    drainDueSequenceSteps.mockImplementationOnce(() => new Promise((r) => (releaseOld = r)));
    await boot();
    await vi.advanceTimersByTimeAsync(60_000); // run 1 starts and hangs
    await vi.advanceTimersByTimeAsync(9 * 60_000); // still inside the ten minutes: skipped
    expect(drainDueSequenceSteps).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000); // past ten minutes: a new run is allowed
    expect(drainDueSequenceSteps).toHaveBeenCalledTimes(2);
    releaseOld({ processed: 0, sent: 0, failed: 0, batches: 1 }); // the stuck run finally settles...
    await vi.advanceTimersByTimeAsync(0);
    let second: (v: unknown) => void = () => {};
    drainDueSequenceSteps.mockImplementationOnce(() => new Promise((r) => (second = r)));
    await vi.advanceTimersByTimeAsync(60_000); // ...run 2 (a fast one) finished earlier, so the next tick starts run 3 normally
    expect(drainDueSequenceSteps.mock.calls.length).toBeGreaterThanOrEqual(3);
    second({ processed: 0, sent: 0, failed: 0, batches: 1 });
  });

  it("health state: not_started before the poller, running after it starts, stalled when silent for over three minutes, disabled when switched off", async () => {
    expect(sequenceSchedulerState(false)).toBe("not_started");
    await boot();
    expect(sequenceSchedulerState(false)).toBe("running");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sequenceSchedulerState(false)).toBe("running");
    expect(sequenceSchedulerState(false, Date.now() + 4 * 60_000)).toBe("stalled");
    expect(sequenceSchedulerState(true, Date.now() + 4 * 60_000)).toBe("disabled");
  });
});
