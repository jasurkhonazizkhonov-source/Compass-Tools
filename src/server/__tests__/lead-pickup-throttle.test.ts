import { describe, it, expect, beforeEach } from "vitest";
import { shouldRunPendingPickup, resetPendingPickupThrottleForTests, PENDING_PICKUP_MIN_INTERVAL_MS } from "../lead-pickup-throttle";

describe("pending-lead pickup throttle", () => {
  beforeEach(() => resetPendingPickupThrottleForTests());

  it("allows the first run, then blocks until the interval has passed (many agents polling do not each scan)", () => {
    const t0 = 1_000_000;
    expect(shouldRunPendingPickup(t0)).toBe(true);
    expect(shouldRunPendingPickup(t0 + 1_000)).toBe(false);
    expect(shouldRunPendingPickup(t0 + PENDING_PICKUP_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(shouldRunPendingPickup(t0 + PENDING_PICKUP_MIN_INTERVAL_MS)).toBe(true);
    expect(shouldRunPendingPickup(t0 + PENDING_PICKUP_MIN_INTERVAL_MS + 1)).toBe(false);
  });
});
