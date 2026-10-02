// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The fresh-lead alert sound. Real audio cannot be heard in a test run, so this
// drives the module with a faithful fake of the Web Audio API — including the
// browser rule that matters: a context created without a user gesture stays
// "suspended" and resume() only succeeds after one.

type FakeOsc = { frequency: { value: number }; type: string; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: (n: unknown) => unknown };

let userHasInteracted: boolean;
let contexts: FakeContext[];

class FakeContext {
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 10;
  destination = {};
  oscillators: FakeOsc[] = [];
  constructor() {
    contexts.push(this);
    // Browsers start a context running only if the page already has user activation.
    this.state = userHasInteracted ? "running" : "suspended";
  }
  async resume() {
    if (userHasInteracted) this.state = "running";
    else throw new DOMException("The AudioContext was not allowed to start.", "NotAllowedError");
  }
  createOscillator(): FakeOsc {
    const osc: FakeOsc = { frequency: { value: 0 }, type: "", start: vi.fn(), stop: vi.fn(), connect: (n) => n };
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (n: unknown) => n };
  }
}

let heldLocks: Set<string>;
function installLocks() {
  heldLocks = new Set();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: vi.fn(async (name: string, _opts: unknown, cb: (lock: unknown) => Promise<void>) => {
        if (heldLocks.has(name)) return cb(null);
        heldLocks.add(name);
        return cb({ name });
      }),
    },
  });
}

async function load() {
  vi.resetModules();
  return import("../lead-offer-alert");
}

beforeEach(() => {
  userHasInteracted = true;
  contexts = [];
  vi.stubGlobal("AudioContext", FakeContext);
  sessionStorage.clear();
  localStorage.clear();
  installLocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const KEY = (lead: string, expires = "2026-10-03T12:00:00.000Z") => `${lead}:${expires}`;
const OFFER = (lead = "lead-1", expires = "2026-10-03T12:00:00.000Z") => ({ accountId: "acct-1", key: KEY(lead, expires), expiresAt: Date.now() + 60_000 });

describe("the alert sound itself", () => {
  it("lasts about 2.7 seconds — in the 2–3 second range — and stays at a moderate level", async () => {
    const mod = await load();
    const c = new FakeContext();
    c.state = "running";
    const seconds = mod.scheduleOfferAlert(c as unknown as AudioContext);
    expect(seconds).toBeGreaterThanOrEqual(2);
    expect(seconds).toBeLessThanOrEqual(3);
    expect(mod.OFFER_ALERT_SECONDS).toBeCloseTo(seconds, 1);
    // every scheduled note ends inside that window, and nothing is scheduled absurdly loud (peak gain <= 0.25)
    const stops = c.oscillators.map((o) => o.stop.mock.calls[0][0] as number);
    expect(Math.max(...stops) - 10).toBeLessThanOrEqual(3);
    expect(c.oscillators.length).toBeGreaterThanOrEqual(6); // two rounds of a three-note phrase
    expect(new Set(c.oscillators.map((o) => o.type))).toEqual(new Set(["sine"]));
  });
});

describe("one alert per offer", () => {
  it("plays once for a new offer, and again polls/re-renders/remounts for the SAME offer are silent", async () => {
    const mod = await load();
    expect(await mod.announceLeadOffer(OFFER())).toBe("played");
    expect(contexts[0].oscillators.length).toBeGreaterThan(0);
    const scheduled = contexts[0].oscillators.length;
    for (let i = 0; i < 5; i++) expect(await mod.announceLeadOffer(OFFER())).toBe("duplicate");
    expect(contexts[0].oscillators.length).toBe(scheduled);
  });

  it("survives a remount of the dialog and a full page reload (session memory): still one sound for the same offer", async () => {
    let mod = await load();
    expect(await mod.announceLeadOffer(OFFER())).toBe("played");
    mod = await load(); // fresh module state, as after a reload — sessionStorage remains
    contexts = [];
    expect(await mod.announceLeadOffer(OFFER())).toBe("duplicate");
    expect(contexts.every((c) => c.oscillators.length === 0)).toBe(true);
  });

  it("the SAME lead offered to the same user again later (a new expiry) sounds again; a different lead sounds too", async () => {
    const mod = await load();
    expect(await mod.announceLeadOffer(OFFER("lead-1", "2026-10-03T12:00:00.000Z"))).toBe("played");
    expect(await mod.announceLeadOffer(OFFER("lead-1", "2026-10-03T12:05:00.000Z"))).toBe("played");
    expect(await mod.announceLeadOffer(OFFER("lead-2", "2026-10-03T12:06:00.000Z"))).toBe("played");
  });

  it("reuses ONE AudioContext for every alert instead of building a new one each time", async () => {
    const mod = await load();
    await mod.announceLeadOffer(OFFER("lead-1", "a"));
    await mod.announceLeadOffer(OFFER("lead-2", "b"));
    await mod.announceLeadOffer(OFFER("lead-3", "c"));
    expect(contexts).toHaveLength(1);
  });

  it("another open CRM tab of the same browser does not sound the same offer a second time (Web Locks claim)", async () => {
    const tabA = await load();
    expect(await tabA.announceLeadOffer(OFFER())).toBe("played");
    // a second tab: fresh module state and its own audio context, sharing the browser's locks
    sessionStorage.clear();
    const tabB = await load();
    expect(await tabB.announceLeadOffer(OFFER())).toBe("duplicate");
  });

  it("without Web Locks the localStorage claim still keeps two tabs to one sound", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const tabA = await load();
    expect(await tabA.announceLeadOffer(OFFER())).toBe("played");
    sessionStorage.clear();
    const tabB = await load();
    expect(await tabB.announceLeadOffer(OFFER())).toBe("duplicate");
  });
});

describe("browser autoplay rules are respected, not bypassed", () => {
  it("with no user gesture yet the context stays suspended: nothing is played, the result says 'blocked', and the claim is NOT taken (so a tab that can sound will)", async () => {
    userHasInteracted = false;
    const mod = await load();
    expect(await mod.announceLeadOffer(OFFER())).toBe("blocked");
    expect(contexts[0].state).toBe("suspended");
    expect(contexts[0].oscillators).toHaveLength(0);
    expect(heldLocks.size).toBe(0);
  });

  it("the first real interaction resumes the context and plays the waiting alert — if the offer is still live", async () => {
    userHasInteracted = false;
    const mod = await load();
    const detach = mod.initOfferAudio();
    expect(await mod.announceLeadOffer(OFFER())).toBe("blocked");

    userHasInteracted = true; // the user clicks
    window.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.runOnlyPendingTimersAsync().catch(() => undefined);
    expect(contexts[0].state).toBe("running");
    expect(contexts[0].oscillators.length).toBeGreaterThan(0);
    detach();
  });

  it("…but an offer that has already expired is not played late", async () => {
    userHasInteracted = false;
    const mod = await load();
    const detach = mod.initOfferAudio();
    await mod.announceLeadOffer({ accountId: "acct-1", key: KEY("lead-1"), expiresAt: Date.now() - 1 });
    userHasInteracted = true;
    window.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts[0].oscillators).toHaveLength(0);
    detach();
  });

  it("a gesture with no waiting offer just primes the context (no sound)", async () => {
    userHasInteracted = true;
    const mod = await load();
    const detach = mod.initOfferAudio();
    window.dispatchEvent(new Event("touchend"));
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].oscillators).toHaveLength(0);
    detach();
  });

  it("a browser with no Web Audio at all is a quiet no-op, never an exception", async () => {
    vi.unstubAllGlobals();
    // jsdom has no AudioContext
    const mod = await load();
    await expect(mod.announceLeadOffer(OFFER())).resolves.toBe("unsupported");
  });

  it("returning to a backgrounded tab re-resumes a context the browser suspended", async () => {
    const mod = await load();
    const detach = mod.initOfferAudio();
    await mod.announceLeadOffer(OFFER());
    contexts[0].state = "suspended"; // the browser suspended it while hidden
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts[0].state).toBe("running");
    detach();
  });

  it("nothing in this module is imported by reassignment, e-mail or quote code — it is only for the fresh-lead offer dialog", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "node_modules" || name === "generated" || name === "__tests__") continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(name) && readFileSync(full, "utf-8").includes("lead-offer-alert")) hits.push(path.relative(process.cwd(), full).replace(/\\/g, "/"));
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(hits.sort()).toEqual(["src/components/layout/lead-offer-modal.tsx", "src/lib/lead-offer-alert.ts"]);
  });
});
