import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The in-process poller started by src/instrumentation.ts register(): ON by default (the VPS deployment relies on it for task-due notifications),
// switched off by DISABLE_IN_PROCESS_POLLER, started once per process, never on the edge runtime, and it runs ONLY the task-notification sweep - the
// sequence sweep is deliberately not part of it (it is driven by /api/cron/sequences). Timers are fake; the sweep is a mock; nothing touches a database.

const runDueTaskNotifications = vi.fn();
vi.mock("@/server/due-task-notifications", () => ({ runDueTaskNotifications: () => runDueTaskNotifications() }));
const runDueSequenceSteps = vi.fn();
vi.mock("@/server/due-sequence-steps", () => ({ runDueSequenceSteps: () => runDueSequenceSteps() }));

beforeEach(() => {
  vi.useFakeTimers();
  runDueTaskNotifications.mockReset().mockResolvedValue({});
  runDueSequenceSteps.mockReset().mockResolvedValue({});
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
  it("default: starts a 60 s interval that runs the task-notification sweep, and nothing else", async () => {
    await boot();
    expect(runDueTaskNotifications).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runDueTaskNotifications).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(3);
    expect(runDueSequenceSteps).not.toHaveBeenCalled();
  });

  it.each(["true", "1", "yes", "on", "TRUE", " On "])("DISABLE_IN_PROCESS_POLLER=%j: nothing is started", async (value) => {
    vi.stubEnv("DISABLE_IN_PROCESS_POLLER", value);
    await boot();
    expect(globalThis.__taskNotifierStarted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runDueTaskNotifications).not.toHaveBeenCalled();
  });

  it.each(["", "false", "0", "no", "off", "disabled"])("DISABLE_IN_PROCESS_POLLER=%j: the poller stays ON (an unknown value never silently disables it)", async (value) => {
    vi.stubEnv("DISABLE_IN_PROCESS_POLLER", value);
    await boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(1);
  });

  it("registering twice (dev fast-refresh) starts ONE interval, not two", async () => {
    await boot();
    await boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(1);
  });

  it("the edge runtime starts nothing", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await boot();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runDueTaskNotifications).not.toHaveBeenCalled();
  });

  it("a failing sweep is logged and the interval keeps running (it never becomes an unhandled rejection)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    runDueTaskNotifications.mockRejectedValueOnce(new Error("db down")).mockResolvedValue({});
    await boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[task-notifier]"), expect.any(Error));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDueTaskNotifications).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
