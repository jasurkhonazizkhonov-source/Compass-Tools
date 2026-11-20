import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { backgroundPollerRunning, startBackgroundPoller, stopBackgroundPoller, STUCK_RUN_MS } from "../background-poller";
import { getSchedulerStatus, resetSchedulerStatusForTests, sequenceSchedulerState } from "../scheduler-status";

// The poller module on its own: startup, shutdown, overlap, stuck runs, per-job error isolation, and what is recorded for health. Fake timers; no database.

beforeEach(() => {
  vi.useFakeTimers();
  resetSchedulerStatusForTests();
});
afterEach(() => {
  stopBackgroundPoller();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ok = () => vi.fn(async () => ({ processed: 1, sent: 1, failed: 0 }));

describe("startup and shutdown", () => {
  it("does nothing until started, starts once (a second start is ignored), and runs both jobs on the interval", async () => {
    const tasks = ok();
    const seq = ok();
    expect(backgroundPollerRunning()).toBe(false);
    startBackgroundPoller([{ name: "tasks", logTag: "t", run: tasks }, { name: "sequences", logTag: "s", run: seq }], 1000);
    startBackgroundPoller([{ name: "tasks", logTag: "t", run: tasks }], 1000);
    expect(backgroundPollerRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tasks).toHaveBeenCalledTimes(3);
    expect(seq).toHaveBeenCalledTimes(3);
  });

  it("stopping schedules no further runs and the state goes back to not started (it never reports running for a stopped poller)", async () => {
    const seq = ok();
    startBackgroundPoller([{ name: "sequences", logTag: "s", run: seq }], 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sequenceSchedulerState(false)).toBe("running");
    stopBackgroundPoller();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seq).toHaveBeenCalledTimes(1);
    expect(backgroundPollerRunning()).toBe(false);
    expect(sequenceSchedulerState(false)).toBe("not_started");
  });

  it("a stopped poller can be started again", async () => {
    const seq = ok();
    startBackgroundPoller([{ name: "sequences", logTag: "s", run: seq }], 1000);
    stopBackgroundPoller();
    startBackgroundPoller([{ name: "sequences", logTag: "s", run: seq }], 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seq).toHaveBeenCalledTimes(1);
  });
});

describe("overlap, stuck runs, isolation", () => {
  it("a run still going when the next tick fires is skipped (no overlapping runs of one job); the other job keeps its schedule", async () => {
    let release: (v: unknown) => void = () => {};
    const slow = vi.fn(() => new Promise((r) => (release = r)));
    const fast = ok();
    startBackgroundPoller([{ name: "sequences", logTag: "s", run: slow }, { name: "tasks", logTag: "t", run: fast }], 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(5);
    release({ processed: 0, sent: 0, failed: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow).toHaveBeenCalledTimes(2);
  });

  it("a run that never settles stops blocking its job after the stuck-run limit, and its late settling does not disturb the replacement", async () => {
    let releaseOld: (v: unknown) => void = () => {};
    const run = vi.fn().mockImplementationOnce(() => new Promise((r) => (releaseOld = r))).mockImplementation(async () => ({ processed: 2, sent: 2, failed: 0 }));
    startBackgroundPoller([{ name: "sequences", logTag: "s", run }], 60_000);
    await vi.advanceTimersByTimeAsync(STUCK_RUN_MS);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    releaseOld({ processed: 0, sent: 0, failed: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(getSchedulerStatus().jobs.sequences.lastOk).toBe(true);
  });

  it("one job failing neither stops the other nor the interval, and only a short CATEGORY is recorded (never the message)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = vi.fn(async () => {
      throw new Error("could not connect to postgres://user:secret@db.internal:5432/app for ada@example.com");
    });
    const fine = ok();
    startBackgroundPoller([{ name: "sequences", logTag: "s", run: boom }, { name: "tasks", logTag: "t", run: fine }], 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fine).toHaveBeenCalledTimes(2);
    expect(boom).toHaveBeenCalledTimes(2);
    const job = getSchedulerStatus().jobs.sequences;
    expect(job.lastOk).toBe(false);
    expect(job.consecutiveFailures).toBe(2);
    expect(job.lastErrorTag).toBeTruthy();
    expect(job.lastErrorTag).not.toMatch(/secret|postgres|ada@/);
    expect(sequenceSchedulerState(false)).toBe("stalled");
    expect(err).toHaveBeenCalled();
  });

  it("recovery: after a failure the next successful run clears the error and the state returns to running", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue({ processed: 0, sent: 0, failed: 0 });
    startBackgroundPoller([{ name: "sequences", logTag: "s", run }], 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sequenceSchedulerState(false)).toBe("stalled");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sequenceSchedulerState(false)).toBe("running");
    expect(getSchedulerStatus().jobs.sequences).toMatchObject({ lastOk: true, lastErrorTag: null, consecutiveFailures: 0 });
  });
});
