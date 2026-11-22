// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import "@/test/rtl-setup";

// RevealResetRefresher: a page that is open across the daily 13:15 Pacific reset asks the server for a fresh render (which masks every address that is no longer revealed).
// Fake timers and fixed instants - nothing waits for a real reset.

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const { RevealResetRefresher } = await import("../reveal-expiry");

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("RevealResetRefresher", () => {
  it("refreshes the open page when the reveal period that was current at load ends (winter, 13:15 PST = 21:15 UTC)", async () => {
    vi.setSystemTime(new Date("2026-11-21T21:14:00Z"));
    render(<RevealResetRefresher />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(refresh).not.toHaveBeenCalled(); // 13:14:30 - still the same period
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1); // 13:15:10 - the boundary passed
  });

  it("uses the Pacific wall clock in summer too (13:15 PDT = 20:15 UTC), not a fixed UTC offset", async () => {
    vi.setSystemTime(new Date("2026-07-10T20:14:00Z"));
    render(<RevealResetRefresher />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a tab that slept through the reset refreshes the moment it is focused again", async () => {
    vi.setSystemTime(new Date("2026-11-21T20:00:00Z"));
    render(<RevealResetRefresher />);
    vi.setSystemTime(new Date("2026-11-22T05:00:00Z")); // hours later; the sleeping tab's timer never fired
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh before the boundary, and renders nothing", () => {
    vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
    const { container } = render(<RevealResetRefresher />);
    window.dispatchEvent(new Event("focus"));
    expect(refresh).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});
