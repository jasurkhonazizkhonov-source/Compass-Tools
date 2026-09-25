// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSharedPoll } from "../use-shared-poll";

// Regression coverage for the multi-tab polling storm: every CRM tab used to
// run its own pollers, so ten tabs meant ten times the database load and a
// starved connection pool ("This page couldn't load"). These tests use
// in-memory fakes of the Web Locks API and BroadcastChannel to prove that
// polling load is independent of the number of open tabs, that leadership
// hands over when the leading tab closes, and that browsers without those
// APIs still poll (as before).

// ── Fake Web Locks: exclusive, FIFO queue, `steal`, abortable waits ──────────
type Waiter = { cb: () => Promise<void>; resolve: (v: unknown) => void; reject: (e: unknown) => void; signal?: AbortSignal };
class FakeLocks {
  private holder: { reject: (e: unknown) => void; token: symbol } | null = null;
  private queue: Waiter[] = [];

  request(_name: string, options: { steal?: boolean; signal?: AbortSignal }, cb: () => Promise<void>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { cb, resolve, reject, signal: options.signal };
      if (options.steal) {
        if (this.holder) this.holder.reject(new DOMException("stolen", "AbortError"));
        this.holder = null;
        this.grant(waiter);
        return;
      }
      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) {
            this.queue.splice(i, 1);
            reject(new DOMException("aborted", "AbortError"));
          }
        });
      }
      if (this.holder) this.queue.push(waiter);
      else this.grant(waiter);
    });
  }

  private grant(waiter: Waiter) {
    const token = Symbol("lock");
    this.holder = { reject: waiter.reject, token };
    void waiter.cb().then(() => {
      if (this.holder?.token === token) {
        this.holder = null;
        waiter.resolve(undefined);
        const next = this.queue.shift();
        if (next) this.grant(next);
      }
    });
  }
}

// ── Fake BroadcastChannel: delivers to every OTHER instance with the same name ─
const channels = new Map<string, Set<FakeBroadcastChannel>>();
class FakeBroadcastChannel {
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(private name: string) {
    if (!channels.has(name)) channels.set(name, new Set());
    channels.get(name)!.add(this);
  }
  postMessage(data: unknown) {
    for (const other of channels.get(this.name) ?? []) {
      if (other !== this) queueMicrotask(() => other.onmessage?.({ data } as MessageEvent));
    }
  }
  close() {
    channels.get(this.name)?.delete(this);
  }
}

let visibility: "visible" | "hidden" = "visible";
function setVisibility(v: "visible" | "hidden") {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

beforeEach(() => {
  vi.useFakeTimers();
  channels.clear();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, "locks", { configurable: true, value: new FakeLocks() });
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else delete (navigator as unknown as { locks?: unknown }).locks;
});

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function mountTab(fetcher: () => Promise<number>, onData: (n: number) => void) {
  return renderHook(() => useSharedPoll({ key: "test", enabled: true, fetcher, onData, visibleIntervalMs: 3000, hiddenIntervalMs: 15000 }));
}

describe("useSharedPoll", () => {
  it("polling load is independent of tab count: 10 tabs poll about as often as 1", async () => {
    const single = vi.fn(async () => 1);
    const solo = mountTab(single, () => {});
    await advance(30_000);
    const soloCalls = single.mock.calls.length;
    solo.unmount();

    channels.clear();
    Object.defineProperty(navigator, "locks", { configurable: true, value: new FakeLocks() });

    const shared = vi.fn(async () => 1);
    const tabs = Array.from({ length: 10 }, () => mountTab(shared, () => {}));
    await advance(30_000);

    // Each tab may fire one initial fetch as leadership passes around while
    // they mount; after that ONE leader polls. Without sharing, 10 tabs
    // would make ~10x the calls (~100).
    expect(shared.mock.calls.length).toBeLessThanOrEqual(soloCalls + 10);
    tabs.forEach((t) => t.unmount());
  });

  it("every tab receives the leader's results over the channel", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => ++n);
    const seenA: number[] = [];
    const seenB: number[] = [];
    mountTab(fetcher, (v) => seenA.push(v));
    mountTab(fetcher, (v) => seenB.push(v));

    await advance(9_000);

    // Whichever tab is leading fetched; BOTH saw the latest value.
    expect(seenA.at(-1)).toBe(n);
    expect(seenB.at(-1)).toBe(n);
    expect(n).toBeGreaterThan(2);
  });

  it("hands leadership to a waiting tab when the leading tab closes — polling continues", async () => {
    let n = 0;
    const fetcher = vi.fn(async () => ++n);
    const seenB: number[] = [];
    const a = mountTab(fetcher, () => {});
    // B opens hidden: it waits its turn rather than stealing.
    setVisibility("hidden");
    mountTab(fetcher, (v) => seenB.push(v));
    setVisibility("visible");
    await advance(3_000);

    const before = n;
    a.unmount(); // the leader tab closes
    await advance(20_000);

    expect(n).toBeGreaterThan(before + 2); // still being polled by the survivor
    expect(seenB.at(-1)).toBe(n);
  });

  it("a background tab does not take over from a foreground leader, but does when it becomes visible", async () => {
    const leaderFetcher = vi.fn(async () => 1);
    const backgroundFetcher = vi.fn(async () => 2);
    mountTab(leaderFetcher, () => {});
    await advance(1_000);

    setVisibility("hidden");
    mountTab(backgroundFetcher, () => {});
    await advance(1_000);
    const backgroundInitial = backgroundFetcher.mock.calls.length; // one data-priming fetch only
    await advance(20_000);
    expect(backgroundFetcher.mock.calls.length).toBe(backgroundInitial);

    // The user switches to it: it becomes the polling tab immediately.
    setVisibility("visible");
    await advance(3_500);
    expect(backgroundFetcher.mock.calls.length).toBeGreaterThan(backgroundInitial);
  });

  it("falls back to independent per-tab polling when Web Locks / BroadcastChannel are unavailable", async () => {
    delete (navigator as unknown as { locks?: unknown }).locks;
    vi.stubGlobal("BroadcastChannel", undefined);
    const fetcher = vi.fn(async () => 1);
    const seen: number[] = [];
    mountTab(fetcher, (v) => seen.push(v));
    await advance(9_500);
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3); // still polls
    expect(seen.length).toBe(fetcher.mock.calls.length);
  });

  it("does nothing while disabled", async () => {
    const fetcher = vi.fn(async () => 1);
    renderHook(() => useSharedPoll({ key: "test", enabled: false, fetcher, visibleIntervalMs: 3000, hiddenIntervalMs: 15000 }));
    await advance(10_000);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a failing fetch never throws out of the hook and polling continues", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return calls;
    });
    const seen: number[] = [];
    mountTab(fetcher, (v) => seen.push(v));
    await advance(7_000);
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(seen.length).toBeGreaterThanOrEqual(1);
  });
});
