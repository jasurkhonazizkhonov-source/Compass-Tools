// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import "@/test/rtl-setup";

// Pass 36 — real, evidence-based optimization: LeadOfferModal previously
// polled getMyLeadOffer() (which doubles as the opportunistic
// sweepExpiredOffers() trigger) every 3 seconds regardless of whether the
// browser tab was even visible. A background tab has no user watching for
// a live offer to respond to, so this suite proves polling slows down
// while hidden and immediately re-syncs the instant the tab becomes
// visible again — never leaving a stale offer/countdown shown longer than
// it takes the user to actually look at the tab.

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

let getMyLeadOfferMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  getMyLeadOfferMock = vi.fn(async () => null);
  vi.doMock("@/server/actions/lead-queue", () => ({
    getMyLeadOffer: getMyLeadOfferMock,
    acceptLeadOffer: vi.fn(),
    skipLeadOffer: vi.fn(),
  }));
  vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
  setVisibility("visible");
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

describe("LeadOfferModal — visibility-aware polling (Pass 36)", () => {
  it("polls every 3s while the tab is visible (the pre-existing foreground rate, unchanged)", async () => {
    const { LeadOfferModal } = await import("../lead-offer-modal");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); }); // flush the initial poll() call

    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(3);
  });

  it("slows to a 15s heartbeat once the tab becomes hidden — no poll at the old 3s mark", async () => {
    const { LeadOfferModal } = await import("../lead-offer-modal");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(1);

    act(() => setVisibility("hidden"));
    // Visibility change to "hidden" itself must NOT poll again immediately —
    // only becoming visible does.
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(1); // still 1 — the old 3s cadence no longer applies

    await act(async () => { await vi.advanceTimersByTimeAsync(12_000); }); // total 15s since hidden
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(2); // the slow heartbeat fired once
  });

  it("polls immediately the instant the tab becomes visible again, rather than waiting out the slow interval", async () => {
    const { LeadOfferModal } = await import("../lead-offer-modal");
    render(<LeadOfferModal accountId="account-1" />);
    await act(async () => { await Promise.resolve(); });
    act(() => setVisibility("hidden"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); }); // well short of the 15s heartbeat
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(1); // no poll yet while hidden

    await act(async () => {
      setVisibility("visible");
      await Promise.resolve();
    });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(2); // immediate re-sync, not a stale-for-up-to-15s wait

    // And the fast 3s cadence resumes from here.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getMyLeadOfferMock).toHaveBeenCalledTimes(3);
  });
});
